import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../database";
import { TaskManager, processStartIdentity } from "../background-tasks";
import { EventHub } from "../events";
import { cleanupStores, createStore, seedModel } from "../test-helpers";
import { recoverInterruptedWork } from "./startup-recovery";

afterEach(() => { vi.restoreAllMocks(); cleanupStores(); });

it("opens persisted work without recovering it until application startup explicitly requests recovery", () => {
  const store = createStore();
  const { model, connection } = seedModel(store);
  const conversation = store.createConversation({ systemPrompt: "" });
  const generation = store.createMessageGeneration(conversation.id, "unfinished");
  const waitingConversation = store.createConversation({ systemPrompt: "" });
  const waiting = store.createMessageGeneration(waitingConversation.id, "approval");
  store.setGenerationWaitingApproval(waiting.generationId);
  const imageModel = store.updateModel(model.id, { imageProtocol: "openai-images", capabilities: { ...model.capabilities, imageOutput: true } })!;
  const image = store.createImageGenerationJob({ conversationId: waitingConversation.id,
    assistantMessageId: store.createImageAssistantMessage(waitingConversation.id), model: imageModel, connection: store.getConnection(connection.id)!,
    request: { modelId: model.id, prompt: "coast", operation: "generate", referenceAssetIds: [], count: 1 } });
  const path = String(store.sqlite.prepare("PRAGMA database_list").get()!.file);
  store.close();
  const reopened = new Store(path);
  try {
    expect(reopened.getGeneration(generation.generationId)?.status).toBe("queued");
    recoverInterruptedWork(reopened.sqlite);
    const interrupted = reopened.getGeneration(generation.generationId)!;
    expect(interrupted.status).toBe("interrupted");
    expect(reopened.getGeneration(waiting.generationId)?.status).toBe("waiting-approval");
    expect(reopened.getImageGenerationJob(image.id)?.status).toBe("queued");
    recoverInterruptedWork(reopened.sqlite);
    expect(reopened.getGeneration(generation.generationId)?.completedAt).toBe(interrupted.completedAt);
  } finally { reopened.close(); }
});

it("only signals a persisted process whose start identity still matches", async () => {
  const store = createStore(); seedModel(store);
  const conversation = store.createConversation({ systemPrompt: "" });
  const generation = store.createMessageGeneration(conversation.id, "tasks");
  const record = store.getGenerationRecord(generation.generationId)!;
  const tasks = new TaskManager(store, new EventHub());
  const snapshot = { ...record.agentSnapshot, execution: { ...record.agentSnapshot.execution, maxBackgroundTasks: 0 } };
  const agent = store.getAgent(snapshot.agentId!)!;
  store.updateAgent(agent.id, { execution: { ...agent.execution, maxBackgroundTasks: 0 } });
  const create = () => tasks.create({ workspacePath: store.dataDir, conversationId: conversation.id, generationId: generation.generationId,
    snapshot, command: "true", mode: "pipe", expectedDurationMs: null, hardTimeoutMs: null });
  const matching = create(); const reused = create(); const missing = create();
  const setProcess = store.sqlite.prepare("UPDATE background_tasks SET status = 'running', pid = ?, process_group_id = ?, process_start_identity = ? WHERE id = ?");
  setProcess.run(process.pid, process.pid, processStartIdentity(process.pid), matching.id);
  setProcess.run(process.pid, process.pid, "different-process", reused.id);
  setProcess.run(null, null, null, missing.id);
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  recoverInterruptedWork(store.sqlite);
  expect(kill).toHaveBeenCalledExactlyOnceWith(-process.pid, "SIGKILL");
  for (const task of [matching, reused, missing]) expect(tasks.get(task.id)?.status).toBe("interrupted");
  await tasks.close();
});
