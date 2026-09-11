import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeGeneration, makeMessage } from "../../test/fixtures";
import { FakeEventSource } from "../../test/setup";
import { appStore, initAuthGate, startAppEvents, stopAppEvents, trackGeneration } from "./app-state";
import { markConversationsDeleted } from "./conversation-lifecycle";

beforeEach(() => {
  vi.useFakeTimers();
  stopAppEvents();
  history.replaceState(null, "", "/c/conv-1");
  localStorage.setItem("llm-chat.offline-enabled", "false");
  appStore.set({ auth: "ready", messages: {}, conversations: [] });
});
afterEach(() => { stopAppEvents(); vi.useRealTimers(); });

function seed(id = "gen-1", conversationId = "conv-1") {
  const message = makeMessage({ id: `message-${id}`, generations: [makeGeneration({ id, status: "running" })] });
  appStore.set((state) => ({ messages: { ...state.messages, [conversationId]: [message] } }));
  trackGeneration(conversationId, message.id, id);
  return FakeEventSource.instances.at(-1)!;
}
const current = (id = "conv-1") => appStore.get().messages[id]![0]!.generations[0]!;
function delta(stream: FakeEventSource, content: string, index = 0, complete = false) {
  stream.emit("block-delta", { type: "block-delta", block: { id: `stream-${index}`, stepIndex: 0, index, type: "text", content, complete } });
}

it("shows the first block immediately and coalesces cumulative text without dropping other blocks", () => {
  const stream = seed();
  const listener = vi.fn(); const unsubscribe = appStore.subscribe(listener);
  delta(stream, "first");
  expect(current().blocks[0]?.content).toBe("first");
  for (let i = 1; i <= 100; i++) delta(stream, `latest ${i}`);
  delta(stream, "second block", 1, true);
  expect(listener).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(49);
  expect(current().blocks).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(current().blocks.map((block) => block.content)).toEqual(["latest 100", "second block"]);
  expect(current().blocks[1]?.complete).toBe(true);
  expect(listener).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(100);
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
});

it.each(["completed", "stopped", "waiting-approval", "error"])("publishes pending text together with %s without waiting for a frame", (status) => {
  const stream = seed();
  delta(stream, "first"); delta(stream, "complete answer", 0, true);
  const listener = vi.fn(); const unsubscribe = appStore.subscribe(listener);
  if (status === "error") stream.emit("error", { type: "error", code: "test", message: "failed" });
  else stream.emit("status", { type: "status", status });
  expect(current()).toMatchObject({ status: status === "error" ? "failed" : status, blocks: [{ content: "complete answer", complete: true }] });
  expect(stream.closed).toBe(true);
  expect(listener).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(50);
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
});

it("flushes pending blocks before tool approval and usage changes", () => {
  const stream = seed();
  delta(stream, "first"); delta(stream, "before tool");
  const call = { id: "call", index: 0, stepIndex: 0, name: "shell", arguments: "{}", output: null, error: null,
    requiresApproval: true, approvalState: "pending", artifacts: [], startedAt: null, completedAt: null };
  stream.emit("tool-call", { type: "tool-call", toolCall: call });
  expect(current()).toMatchObject({ blocks: [{ content: "before tool" }], toolCalls: [call] });
  delta(stream, "next"); delta(stream, "latest");
  stream.emit("usage", { type: "usage", usage: { outputTokens: 12 } });
  expect(current()).toMatchObject({ blocks: [{ content: "latest" }], usage: { outputTokens: 12 } });
});

it("replaces buffered content with an authoritative reconnect snapshot", () => {
  const stream = seed();
  delta(stream, "first"); delta(stream, "stale");
  const generation = makeGeneration({ status: "running", blocks: [{ id: "persisted", index: 0, stepIndex: 0, type: "text", content: "snapshot", complete: false }] });
  stream.emit("snapshot", { type: "snapshot", generation });
  vi.advanceTimersByTime(50);
  expect(current().blocks[0]?.content).toBe("snapshot");
  delta(stream, "after reconnect");
  expect(current().blocks).toHaveLength(1);
  expect(current().blocks[0]?.content).toBe("after reconnect");
});

it("keeps simultaneous generations independent", () => {
  const first = seed(); const second = seed("gen-2", "conv-2");
  delta(first, "a"); delta(first, "aa");
  delta(second, "b"); delta(second, "bb");
  vi.advanceTimersByTime(50);
  expect(current().blocks[0]?.content).toBe("aa");
  expect(current("conv-2").blocks[0]?.content).toBe("bb");
});

it("retains the last buffered text when the app-wide stream reports completion first", () => {
  const stream = seed(); startAppEvents();
  delta(stream, "first"); delta(stream, "last");
  FakeEventSource.instances.find((source) => source.url === "/api/events")!.emit("generation-state", {
    type: "generation-state", generation: { conversationId: "conv-1", messageId: "message-gen-1", generationId: "gen-1", status: "completed", stopReason: "stop" }
  });
  expect(current()).toMatchObject({ status: "completed", blocks: [{ content: "last" }] });
});

it.each(["stop", "delete", "logout"])("does not publish delayed updates after %s", (action) => {
  const stream = seed();
  delta(stream, "first"); delta(stream, "pending");
  let dispose: (() => void) | undefined;
  if (action === "stop") stopAppEvents();
  else if (action === "delete") markConversationsDeleted(["conv-1"]);
  else { dispose = initAuthGate(); window.dispatchEvent(new Event("llm-chat:offline-auth-required")); }
  const messages = appStore.get().messages;
  vi.advanceTimersByTime(50);
  expect(appStore.get().messages).toBe(messages);
  if (action !== "stop") expect(messages["conv-1"]).toBeUndefined();
  dispose?.();
});
