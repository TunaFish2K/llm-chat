import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appStore, initAuthGate, loadMessages, refreshMessages, releaseInactiveMessages, startAppEvents, stopAppEvents, trackGeneration } from "./app-state";
import { makeGeneration, makeMessage } from "../../test/fixtures";
import { FakeEventSource } from "../../test/setup";

beforeEach(() => {
  stopAppEvents(); appStore.set({ auth: "ready", messages: {} });
  localStorage.setItem("llm-chat.offline-enabled", "false");
});
afterEach(() => { stopAppEvents(); vi.useRealTimers(); history.replaceState(null, "", "/"); });
const respond = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

it("retains only the viewed and generating chats, including after late responses", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => respond([makeMessage({ role: "user", text: "x".repeat(100_000), generations: [] })])));
  for (let i = 0; i < 60; i++) {
    history.replaceState(null, "", `/c/chat-${i}`);
    await loadMessages(`chat-${i}`);
    expect(Object.keys(appStore.get().messages)).toEqual([`chat-${i}`]);
  }
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  const read = loadMessages("chat-59");
  history.replaceState(null, "", "/settings"); releaseInactiveMessages();
  finish(respond([makeMessage({ generations: [] })])); await read;
  expect(appStore.get().messages).toEqual({});
});

it("releases ended background generations and their owners without dropping active ones", () => {
  history.replaceState(null, "", "/c/foreground");
  for (let i = 0; i < 100; i++) {
    const id = `generation-${i}`;
    appStore.set({ messages: { background: [makeMessage({ id: "message", generations: [makeGeneration({ id, status: "running" })] })] } });
    trackGeneration("background", "message", id);
    releaseInactiveMessages(); expect(appStore.get().messages.background).toHaveLength(1);
    FakeEventSource.instances.at(-1)!.emit("snapshot", { type: "snapshot", generation: makeGeneration({ id, status: "completed" }) });
    expect(appStore.get().messages).toEqual({});
  }
  // A leaked owner would pin this completed conversation again.
  appStore.set({ messages: { background: [makeMessage({ generations: [] })] } });
  releaseInactiveMessages(); expect(appStore.get().messages).toEqual({});
});

it("merges a replay burst into one request and refreshes once after an in-flight read", async () => {
  vi.useFakeTimers(); history.replaceState(null, "", "/c/current");
  const fetch = vi.fn(async () => respond([makeMessage({ generations: [] })])); vi.stubGlobal("fetch", fetch);
  startAppEvents(); const source = FakeEventSource.instances.find((item) => item.url === "/api/events")!;
  for (let i = 0; i < 100; i++) source.emit("image-generation", { type: "image-generation", id: i, conversationId: "current" });
  source.emit("image-generation", { type: "image-generation", id: 100, conversationId: "unrelated" });
  await vi.advanceTimersByTimeAsync(100); expect(fetch).toHaveBeenCalledOnce();
  let finish!: (value: Response) => void;
  fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
  const read = loadMessages("current");
  for (let i = 0; i < 100; i++) source.emit("image-generation", { type: "image-generation", id: i + 101, conversationId: "current" });
  await vi.advanceTimersByTimeAsync(100); expect(fetch).toHaveBeenCalledTimes(2);
  finish(respond([makeMessage({ text: "old", generations: [] })])); await read;
  await vi.advanceTimersByTimeAsync(100); expect(fetch).toHaveBeenCalledTimes(3);
});

it("does not restore messages from an outstanding request after logout", async () => {
  vi.useFakeTimers(); history.replaceState(null, "", "/c/current");
  const dispose = initAuthGate();
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  const read = loadMessages("current");
  refreshMessages("current");
  await vi.advanceTimersByTimeAsync(100);
  window.dispatchEvent(new Event("llm-chat:offline-auth-required"));
  finish(respond([makeMessage({ generations: [] })])); await read;
  await vi.advanceTimersByTimeAsync(100);
  expect(fetch).toHaveBeenCalledOnce();
  expect(appStore.get().auth).toBe("required"); expect(appStore.get().messages).toEqual({});
  dispose();
});

it("accepts an offline fallback while stopping network subscriptions", async () => {
  history.replaceState(null, "", "/c/current");
  let finish!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  const read = loadMessages("current");
  stopAppEvents();
  finish(respond([makeMessage({ text: "offline history", generations: [] })]));
  await read;
  expect(appStore.get().messages.current?.[0]?.text).toBe("offline history");
});

it("releases a background generation that finished while subscriptions were stopped", async () => {
  vi.useFakeTimers(); history.replaceState(null, "", "/c/foreground");
  const generation = makeGeneration({ id: "disconnected", status: "running" });
  const message = makeMessage({ id: "message", generations: [generation] });
  appStore.set({ messages: { background: [message] } });
  trackGeneration("background", message.id, generation.id);
  stopAppEvents();
  vi.stubGlobal("fetch", vi.fn(async () => respond([{ ...message, generations: [{ ...generation, status: "completed" }] }])));
  startAppEvents();
  const source = FakeEventSource.instances.filter((item) => item.url === "/api/events").at(-1)!;
  source.emit("generation-snapshot", { type: "generation-snapshot", id: 1, sourceId: "server", active: [] });
  await vi.advanceTimersByTimeAsync(100);
  expect(appStore.get().messages).toEqual({});
});
