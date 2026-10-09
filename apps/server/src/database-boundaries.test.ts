import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { cleanupStores, createStore, seedModel } from "./test-helpers";
import { assertImageConfiguration } from "./image-configuration";

afterEach(cleanupStores);
const missing = "00000000-0000-4000-8000-000000000000";

it("rejects stale attachment owners and enforces image count and size atomically", () => {
  const store = createStore(); const { model } = seedModel(store); const agentId = store.getSettings().defaultAgentId;
  const images = Array.from({ length: 5 }, (_, index) => store.createImageAsset({ sha256: String(index).repeat(64), fileName: `${index}.png`, mimeType: "image/png", byteSize: 5 * 1024 ** 2, storageKey: `images/${index}` }));
  expect(() => store.attachFileToAgent(missing, images[0]!.id)).toThrow("Agent 不存在");
  expect(() => store.attachFileToAgent(agentId, missing)).toThrow("文件资产不存在");
  expect(() => store.attachFileToToolCall(missing, missing)).toThrow("文件资产不存在");
  expect(() => store.validateAttachments(images.map(item => item.id))).toThrow("最多包含 4 张图片");
  expect(() => store.validateAttachments(images.slice(0, 4).map(item => item.id))).not.toThrow();
  store.updateSettings({ maxImageUploadMiB: 4 });
  expect(store.imageLimits()).toEqual({ image: 4 * 1024 ** 2, message: 16 * 1024 ** 2 });
  expect(() => store.validateAttachments(images.slice(0, 4).map(item => item.id))).toThrow("16 MiB");
  expect(() => store.validateAttachments([missing])).toThrow("文件资产不存在");
  expect(() => assertImageConfiguration(store, agentId, model.id, [missing])).toThrow("图片资产不存在");
  expect(() => assertImageConfiguration(store, null, model.id, [])).toThrow("选择可用 Agent");
  expect(() => assertImageConfiguration(store, agentId, null, [])).toThrow("选择可用模型");
  expect(() => assertImageConfiguration(store, agentId, model.id, [images[0]!.id])).toThrow("备用识图模型");
  store.updateModel(model.id, { capabilities: { ...model.capabilities, imageInput: true } });
  expect(() => assertImageConfiguration(store, agentId, model.id, [images[0]!.id])).not.toThrow();
  const plain = store.createModel({ ...model, modelKey: "plain" });
  const agent = store.getAgent(agentId)!;
  store.updateAgent(agentId, { execution: { ...agent.execution, visionModelId: model.id } });
  expect(() => assertImageConfiguration(store, agentId, plain.id, [])).not.toThrow();
  store.updateModel(model.id, { enabled: false });
  expect(() => assertImageConfiguration(store, agentId, plain.id, [])).toThrow("备用识图模型");
  expect(() => store.updateAgentSearchSecret(missing, "searxng", "secret")).toThrow("Agent 不存在");
});

it("keeps image jobs transactional and tolerates missing or invalid persisted receipts", () => {
  const store = createStore(); const { connection, model } = seedModel(store); const conversation = store.createConversation({ systemPrompt: "" });
  const request = { modelId: model.id, prompt: "image", operation: "generate" as const, referenceAssetIds: [], count: 1 };
  expect(() => store.createImageAssistantMessage(missing)).toThrow("会话不存在");
  expect(() => store.createImageGenerationJob({ conversationId: conversation.id, connection: store.getConnection(connection.id)!, model, request })).toThrow("缺少图片协议");
  expect(store.listMessages(conversation.id)).toEqual([]);
  const imageModel = store.updateModel(model.id, { imageProtocol: "openai-images", capabilities: { ...model.capabilities, imageOutput: true } })!;
  const job = store.createImageGenerationJob({ conversationId: conversation.id, connection: store.getConnection(connection.id)!, model: imageModel, request });
  expect(store.getImageGenerationInput(missing)).toBeUndefined(); expect(store.updateImageGenerationJob(missing, { status: "failed" })).toBeUndefined(); expect(store.attachImageJobOutputs(missing, [])).toBeUndefined();
  store.updateImageGenerationJob(job.id, { status: "failed", progress: null, providerJobId: "receipt", startedAt: 1, completedAt: 2, revisedPrompt: "revised", error: { code: "provider_error", message: "failed", i18n: { key: "error.operation_canceled" } } });
  expect(store.getImageGenerationJob(job.id)).toMatchObject({ providerJobId: "receipt", startedAt: 1, completedAt: 2, error: { i18n: { key: "error.operation_canceled" } } });
  expect(store.allContextMessages(conversation.id)[0]?.text).toContain("failed");
  store.updateImageGenerationJob(job.id, { error: null, providerJobId: null, revisedPrompt: null });
  store.sqlite.prepare("UPDATE image_generation_jobs SET request_json = ?, output_asset_ids_json = ? WHERE id = ?").run("{}", '[42,"missing"]', job.id);
  expect(store.getImageGenerationInput(job.id)).toBeUndefined(); expect(store.getImageGenerationJob(job.id)?.outputAssets).toEqual([]);
  store.sqlite.prepare("UPDATE image_generation_jobs SET output_asset_ids_json = 'null' WHERE id = ?").run(job.id);
  expect(store.getImageGenerationJob(job.id)?.outputAssets).toEqual([]);
});

it("stores independent image sessions with owned assets and selectable timeline versions", () => {
  const store = createStore();
  const { connection, model } = seedModel(store);
  const imageModel = store.updateModel(model.id, {
    imageProtocol: "openai-images",
    capabilities: { ...model.capabilities, imageOutput: true, imageEdit: true }
  })!;
  const session = store.createImageSession({ title: "Concept board", draft: { modelId: imageModel.id, prompt: "glass house" } });
  const other = store.createImageSession({});
  const reference = store.createImageAsset({
    sha256: "c".repeat(64), fileName: "reference.png", mimeType: "image/png", byteSize: 8, storageKey: "reference"
  });
  const plain = store.createFileAsset({
    sha256: "d".repeat(64), fileName: "notes.txt", mimeType: "text/plain", kind: "file", byteSize: 4, storageKey: "notes"
  });
  expect(() => store.attachAssetsToImageSession(session.id, [plain.id])).toThrow("只能添加有效图片");
  expect(store.attachAssetsToImageSession(session.id, [reference.id]).assets).toEqual([expect.objectContaining({ id: reference.id })]);
  expect(store.imageAssetBelongsToSession(session.id, reference.id)).toBe(true);
  expect(store.imageAssetBelongsToSession(other.id, reference.id)).toBe(false);

  const request = {
    modelId: imageModel.id, prompt: "glass house", operation: "edit" as const,
    referenceAssetIds: [reference.id], count: 1
  };
  const first = store.createImageGenerationJob({
    imageSessionId: session.id, connection: store.getConnection(connection.id)!, model: imageModel, request
  });
  const second = store.createImageGenerationJob({
    imageSessionId: session.id, imageNodeId: first.imageNodeId!, connection: store.getConnection(connection.id)!,
    model: imageModel, request: { ...request, prompt: "glass house at dusk" }
  });
  expect(store.listMessages(store.createConversation({ systemPrompt: "" }).id)).toEqual([]);
  expect(store.getImageSession(session.id)?.nodes[0]).toMatchObject({
    id: first.imageNodeId, selectedJobId: second.id, versions: [{ id: first.id }, { id: second.id }]
  });
  expect(() => store.createImageGenerationJob({
    imageSessionId: other.id, imageNodeId: first.imageNodeId!, connection: store.getConnection(connection.id)!, model: imageModel, request
  })).toThrow("绘图节点不存在");

  const output = store.createImageAsset({
    sha256: "e".repeat(64), fileName: "output.png", mimeType: "image/png", byteSize: 12, storageKey: "output"
  });
  store.attachImageJobOutputs(first.id, [output.id]);
  store.updateImageGenerationJob(first.id, { status: "completed", completedAt: Date.now() });
  expect(store.selectImageSessionVersion(session.id, first.imageNodeId!, first.id).selectedJobId).toBe(first.id);
  expect(store.listImageSessions()[0]).toMatchObject({ id: session.id, coverAsset: { id: output.id }, nodeCount: 1 });
  expect(store.unreferencedFileAssets(Date.now() + 1).map((asset) => asset.id)).not.toContain(output.id);

  expect(store.deleteImageSessionVersion(session.id, first.imageNodeId!, first.id)?.versions).toHaveLength(1);
  expect(store.deleteImageSessionVersion(session.id, first.imageNodeId!, second.id)).toBeNull();
  expect(store.getImageSession(session.id)?.nodes).toEqual([]);
  expect(store.updateImageSession(session.id, { title: "Updated", draft: { count: 2 } })).toMatchObject({
    title: "Updated", draft: { prompt: "glass house", count: 2 }
  });
  expect(store.deleteImageSession(session.id)).toBe(true);
  expect(store.getImageSession(session.id)).toBeUndefined();
});

it("keeps shared blobs until the final asset is removed", () => {
  const store = createStore();
  const input = { sha256: "a".repeat(64), fileName: "a.txt", mimeType: "text/plain", kind: "file" as const, byteSize: 5, storageKey: "blob" };
  const first = store.createFileAsset(input), second = store.createFileAsset({ ...input, fileName: "b.txt" });
  expect(store.getImageAsset(first.id)).toBeUndefined();
  expect(store.deleteFileAsset(first.id)).toEqual({ deleted: true, storageKey: null });
  expect(store.getFileAsset(second.id)?.byteSize).toBe(5);
  expect(store.deleteFileAsset(second.id)).toEqual({ deleted: true, storageKey: "blob" });
  expect(store.deleteFileAsset(second.id)).toEqual({ deleted: false, storageKey: null });
});

it("handles stale roleplay settings and removes the last selected Agent safely", () => {
  const store = createStore(); seedModel(store); const base = store.getAgent(store.getSettings().defaultAgentId)!;
  const agent = store.createAgent({ ...base, card: { ...base.card, data: { ...base.card.data, name: "temporary" } } });
  const conversation = store.createConversation({ agentId: agent.id });
  store.updateSettings({ lastAgentId: agent.id });
  expect(() => store.getConversationRoleplayState(missing)).toThrow("会话不存在");
  expect(() => store.updateConversationRoleplayState(missing, {})).toThrow("会话不存在");
  expect(store.deleteAgent(agent.id)).toBe(true); expect(store.getSettings().lastAgentId).toBe(base.id);
  expect(() => store.getConversationRoleplayState(conversation.id)).toThrow();
  expect(() => store.updateConversationRoleplayState(conversation.id, {})).toThrow("选择 Agent");
  expect(() => store.forkConversation(conversation.id, { mode: "continue", throughMessageId: null })).toThrow("Agent 已不可用");
  expect(() => store.createConversation({ agentId: missing })).toThrow("Agent 不存在");
  expect(() => store.updateConversation(conversation.id, { agentId: missing })).toThrow("Agent 不存在");
  expect(store.updateConversation(conversation.id, { agentId: null, contextPolicy: "full", systemPrompt: "legacy" })).toMatchObject({ modelId: null, contextPolicy: "full", systemPrompt: "legacy" });
});

it("rejects invalid branch selections and forks without corrupting original history", () => {
  const store = createStore(); seedModel(store);
  const conversation = store.createConversation({ systemPrompt: "" }); const other = store.createConversation({ systemPrompt: "" });
  expect(() => store.forkConversation(missing, { mode: "continue", throughMessageId: null })).toThrow("会话不存在");
  expect(() => store.selectConversationBranch(conversation.id, missing)).toThrow("会话不存在");
  expect(() => store.selectConversationBranch(conversation.id, other.id)).toThrow("不属于当前会话");
  const created = store.createMessageGeneration(conversation.id, "original");
  expect(() => store.forkConversation(conversation.id, { mode: "continue", throughMessageId: created.assistantMessageId })).toThrow("未完成");
  store.finishGeneration(created.generationId, "completed", {});
  expect(() => store.forkConversation(conversation.id, { mode: "edit", messageId: created.assistantMessageId, text: "wrong" })).toThrow();
  expect(() => store.createRetryGeneration(store.listMessages(conversation.id)[0]!.id)).toThrow();
  expect(() => store.forkConversation(conversation.id, { mode: "greeting", messageId: created.assistantMessageId, greetingIndex: 0 })).toThrow();
  expect(store.listMessages(conversation.id)).toHaveLength(2);
});

it("preserves localized queue failure and rejects stale queue operations", () => {
  const store = createStore(); seedModel(store); const conversation = store.createConversation({ systemPrompt: "" });
  expect(() => store.enqueueMessage(missing, "text", [])).toThrow("会话不存在"); expect(() => store.deleteQueuedMessages(missing)).toThrow("会话不存在");
  expect(store.dispatchQueuedMessage(conversation.id, () => {})).toBeNull();
  const queued = store.enqueueMessage(conversation.id, "queued", []);
  store.sqlite.prepare("UPDATE queued_messages SET error_i18n_json = ? WHERE id = ?").run(JSON.stringify({ key: "error.operation_canceled" }), queued.id);
  expect(store.listQueuedMessages(conversation.id)[0]).toMatchObject({ errorI18n: { key: "error.operation_canceled" } });
  store.dispatchQueuedMessage(conversation.id, () => { throw "invalid attachment"; });
  expect(store.listQueuedMessages(conversation.id)[0]).toMatchObject({ status: "failed", error: "消息发送失败" });
  store.deleteQueuedMessages(conversation.id); expect(store.listQueuedMessages(conversation.id)).toEqual([]);
});

it("reads generation snapshots from legacy records after their Agent is removed", () => {
  const store = createStore(); const { model, connection } = seedModel(store); const base = store.getAgent(store.getSettings().defaultAgentId)!;
  const agent = store.createAgent({ ...base, card: { ...base.card, data: { ...base.card.data, name: "legacy" } } });
  const conversation = store.createConversation({ agentId: agent.id }); const generation = store.createMessageGeneration(conversation.id, "history");
  store.finishGeneration(generation.generationId, "completed", {}); store.deleteAgent(agent.id);
  store.sqlite.prepare("UPDATE generations SET agent_snapshot_json = NULL WHERE id = ?").run(generation.generationId);
  const record = store.getGenerationRecord(generation.generationId)!;
  expect(record.agentSnapshot.agentId).toBeNull(); expect(record.agentSnapshot.execution.modelId).toBe(model.id); expect(record.agentSnapshot.roleplay.enabled).toBe(false);
  store.sqlite.prepare("UPDATE connections SET provider_id = 'retired-provider', secret_headers_json = '{' WHERE id = ?").run(connection.id);
  expect(store.getConnection(connection.id)).toMatchObject({ providerId: "custom", secretHeaders: {} });
  expect(store.getVisionAnalysis(randomUUID())).toBeUndefined(); expect(store.getContextSummary(conversation.id)).toBeUndefined();
});
