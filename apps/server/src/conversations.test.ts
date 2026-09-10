import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationService } from "./conversations";
import { EventHub } from "./events";
import { ImageGenerationManager } from "./image-generation";
import { attachmentFileName, ImageService } from "./images";
import { TaskManager } from "./background-tasks";
import { cleanupStores, createStore, seedModel } from "./test-helpers";

afterEach(() => { vi.restoreAllMocks(); cleanupStores(); });

async function setup() {
  const store = createStore();
  const { model } = seedModel(store);
  const root = store.createConversation({ systemPrompt: "" });
  const child = store.forkConversation(root.id, { mode: "continue", throughMessageId: null }).conversation;
  const events = new EventHub();
  const files = new ImageService(store);
  await files.initialize();
  const tasks = new TaskManager(store, events);
  const imageJobs = new ImageGenerationManager(store, files, events);
  const startGeneration = vi.fn();
  const service = new ConversationService({ store, tasks, imageJobs, files, events, startGeneration });
  return { store, model, root, child, events, files, tasks, imageJobs, startGeneration, service };
}

describe("conversation deletion", () => {
  it.each(["queued", "running", "waiting-approval"] as const)("protects a branch with a %s generation", async (status) => {
    const { store, root, child, service } = await setup();
    const generation = store.createMessageGeneration(child.id, "active branch");
    if (status === "running") store.setGenerationRunning(generation.generationId);
    if (status === "waiting-approval") store.setGenerationWaitingApproval(generation.generationId);
    await expect(service.delete(root.id)).rejects.toMatchObject({ code: "conversation_busy" });
    expect(store.getConversation(root.id)).toBeDefined();
    expect(store.getConversation(child.id)).toBeDefined();
    expect(store.getGeneration(generation.generationId)?.status).toBe(status);
  });

  it.each(["root", "child"] as const)("protects image jobs in the %s", async (target) => {
    const fixture = await setup();
    const { store, model, root, imageJobs, service } = fixture;
    store.updateModel(model.id, { capabilities: { ...model.capabilities, imageOutput: true }, imageProtocol: "openai-images" });
    const job = imageJobs.create({ conversationId: fixture[target].id, input: {
      modelId: model.id, prompt: "beach", operation: "generate", referenceAssetIds: [], count: 1
    } });
    await expect(service.delete(root.id)).rejects.toMatchObject({ code: "conversation_image_tasks_active" });
    expect(store.getImageGenerationJob(job.id)?.status).toBe("queued");
    expect(store.getConversation(root.id)).toBeDefined();
    imageJobs.cancel(job.id);
    await service.delete(root.id);
    expect(store.getConversation(root.id)).toBeUndefined();
  });

  it("protects independent background work after its generation completes", async () => {
    const { store, root, child, tasks, service } = await setup();
    const generation = store.createMessageGeneration(child.id, "background");
    const snapshot = store.getGenerationRecord(generation.generationId)!.agentSnapshot;
    const agent = store.getAgent(snapshot.agentId!)!;
    store.updateAgent(agent.id, { execution: { ...agent.execution, maxBackgroundTasks: 0 } });
    const task = tasks.create({ workspacePath: store.dataDir, conversationId: child.id, generationId: generation.generationId,
      snapshot: { ...snapshot, execution: { ...snapshot.execution, maxBackgroundTasks: 0 } },
      command: "true", mode: "pipe", expectedDurationMs: null, hardTimeoutMs: null });
    store.finishGeneration(generation.generationId, "completed", {});
    await expect(service.delete(root.id)).rejects.toMatchObject({ code: "conversation_tasks_active" });
    expect(tasks.get(task.id)?.status).toBe("queued");
    await tasks.close();
  });

  it("cleans every deleted branch while retaining unrelated conversations", async () => {
    const { store, root, child, files, events, service } = await setup();
    const siblingRoot = store.createConversation({ systemPrompt: "" });
    const grandchild = store.forkConversation(child.id, { mode: "continue", throughMessageId: null }).conversation;
    const cleanup = vi.spyOn(files, "scheduleAttachmentWorkspaceCleanup").mockResolvedValue();
    const emit = vi.spyOn(events, "emit");
    await service.delete(root.id);
    for (const id of [root.id, child.id, grandchild.id]) {
      expect(store.getConversation(id)).toBeUndefined();
      expect(cleanup).toHaveBeenCalledWith(id);
      expect(emit).toHaveBeenCalledWith({ type: "resource-changed", resource: "conversations", resourceId: id });
    }
    expect(store.getConversation(siblingRoot.id)).toBeDefined();
    await expect(service.delete(root.id)).rejects.toMatchObject({ code: "conversation_not_found" });
  });

  it("attempts all cleanups and publishes committed deletions even if one cleanup fails", async () => {
    const { store, root, child, files, events, service } = await setup();
    const cleanup = vi.spyOn(files, "scheduleAttachmentWorkspaceCleanup").mockRejectedValueOnce(new Error("rename failed")).mockResolvedValue();
    const emit = vi.spyOn(events, "emit");
    await expect(service.delete(root.id)).rejects.toThrow("rename failed");
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(store.getConversation(child.id)).toBeUndefined();
  });
});

describe("conversation forks", () => {
  it("rebuilds attachments before starting an edited generation", async () => {
    const { store, root, files, service, startGeneration } = await setup();
    const generation = store.createMessageGeneration(root.id, "original");
    store.finishGeneration(generation.generationId, "completed", {});
    const asset = await files.importFile("note.txt", "text/plain", Buffer.from("attachment"));
    startGeneration.mockImplementation((id: string) => {
      const record = store.getGenerationRecord(id)!;
      const message = store.listMessages(record.conversationId)[0]!;
      const path = join(files.attachmentWorkspace(record.conversationId), "incoming", message.id, attachmentFileName(asset));
      expect(readFileSync(path, "utf8")).toBe("attachment");
    });
    const result = await service.fork(root.id, { mode: "edit", messageId: generation.userMessageId!, text: "edited", assetIds: [asset.id] });
    const attachment = store.listMessages(result.conversation.id)[0]!.attachments[0]!;
    expect(attachment.id).toBe(asset.id);
    expect(startGeneration).toHaveBeenCalledWith(result.generation!.generationId);

  });

  it("checks image capability before creating an edited branch", async () => {
    const { store, model, root, files, service, startGeneration } = await setup();
    const generation = store.createMessageGeneration(root.id, "original");
    store.finishGeneration(generation.generationId, "completed", {});
    const asset = await files.importFile("pixel.png", "image/png", Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const input = { mode: "edit" as const, messageId: generation.userMessageId!, text: "image", assetIds: [asset.id] };
    await expect(service.fork(root.id, input)).rejects.toMatchObject({ code: "vision_model_required" });
    expect(store.listConversations()).toHaveLength(2);
    expect(startGeneration).not.toHaveBeenCalled();
    store.updateModel(model.id, { capabilities: { ...model.capabilities, imageInput: true } });
    const fork = await service.fork(root.id, input);
    expect(startGeneration).toHaveBeenCalledWith(fork.generation!.generationId);
    await expect(service.fork("missing", input)).rejects.toMatchObject({ code: "conversation_not_found" });
  });

  it("does not start a generation if attachment reconstruction fails", async () => {
    const { store, root, files, service, startGeneration } = await setup();
    const generation = store.createMessageGeneration(root.id, "original");
    store.finishGeneration(generation.generationId, "completed", {});
    vi.spyOn(files, "cloneAttachmentWorkspace").mockRejectedValue(new Error("disk unavailable"));
    await expect(service.fork(root.id, { mode: "edit", messageId: generation.userMessageId!, text: "edited" })).rejects.toThrow("disk unavailable");
    expect(startGeneration).not.toHaveBeenCalled();
  });
});
