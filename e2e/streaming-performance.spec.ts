import { expect, test } from "./fixtures";
import { APP_URL } from "./helpers.mjs";
import { makeSettings, makeAgent, makeConnection, makeModel, makeConversation, makeGeneration, makeMessage } from "../apps/web/test/fixtures";

interface ProbeSource extends EventTarget { url: string; closed: boolean }
interface ProbeWindow extends Window {
  sources: ProbeSource[];
  commits: number;
  EventSource: typeof EventSource;
  __REACT_DEVTOOLS_GLOBAL_HOOK__: object;
}

for (const modelCount of [1, 300]) test(`短回复流式更新保持可交互（${modelCount} 个模型）`, async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "使用移动 Chromium CPU 降速测量");
  const generation = makeGeneration({ status: "running", completedAt: null });
  const messages = [
    makeMessage({ id: "user", role: "user", text: "你好", generations: [] }),
    makeMessage({ id: "assistant", ordinal: 2, generations: [generation], activeGenerationId: generation.id })
  ];
  const data = { settings: makeSettings(), agents: [makeAgent()], connections: [makeConnection()],
    models: Array.from({ length: modelCount }, (_, index) => makeModel({ id: `model-${index + 1}` })),
    conversations: [makeConversation()], messages };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path === "/api/offline/manifest" ? { ...data, sourceId: "performance", conversations: data.conversations.map((item) => ({ ...item, cacheRevision: 1 })) }
      : path === "/api/bootstrap" ? data : path === "/api/conversations" ? data.conversations
      : path.endsWith("/messages") ? messages : path.endsWith("/queue") ? { items: [], paused: false }
      : path === "/api/settings" ? data.settings : [];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.addInitScript(() => {
    localStorage.setItem("llm-chat.offline-enabled", "false");
    localStorage.setItem("llm-chat.quick-tour.v1", "seen");
    const probe = window as unknown as ProbeWindow;
    probe.sources = []; probe.commits = 0;
    probe.EventSource = class extends EventTarget {
      closed = false;
      constructor(public url: string) { super(); probe.sources.push(this); }
      close() { this.closed = true; }
    } as unknown as typeof EventSource;
    probe.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, inject: () => 1,
      onCommitFiberRoot: () => { probe.commits++; }, onCommitFiberUnmount: () => undefined };
  });
  await page.goto(`${APP_URL}/c/conv-1`);
  await expect(page.locator(".stream-pending")).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const text = "这是一段普通的中文短回复，用于检查手机流式交互。".repeat(5);
  const streaming = page.evaluate(async (text) => {
    const probe = window as unknown as ProbeWindow;
    const source = probe.sources.findLast((item) => item.url === "/api/generations/gen-1/events" && !item.closed)!;
    const longTasks: number[] = [];
    const observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((entry) => entry.duration)));
    observer.observe({ type: "longtask" });
    const commits = probe.commits;
    const started = performance.now();
    for (let index = 1; index <= text.length; index++) {
      source.dispatchEvent(new MessageEvent("block-delta", { data: JSON.stringify({ type: "block-delta", generationId: "gen-1",
        block: { id: "gen-1:0", index: 0, stepIndex: 0, type: "text", content: text.slice(0, index), complete: false } }) }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    observer.disconnect();
    return { commits: probe.commits - commits, durationMs: performance.now() - started, longTasks };
  }, text);
  await expect(page.locator(".markdown")).toBeVisible();
  // Measure browser input handling separately from Playwright's locator/actionability polling.
  await page.evaluate(() => {
    document.querySelector("textarea")!.addEventListener("input", () => {
      performance.mark("stream-input");
      requestAnimationFrame(() => performance.measure("stream-input-paint", "stream-input"));
    }, { once: true });
  });
  await page.getByLabel("输入消息", { exact: true }).fill("生成中继续输入");
  await expect(page.getByLabel("输入消息", { exact: true })).toHaveValue("生成中继续输入");
  await page.getByRole("button", { name: "低频设置", exact: true }).click();
  await expect(page.getByRole("button", { name: "高级执行设置" })).toBeVisible();
  await page.keyboard.press("Escape");
  const metrics = await streaming;
  const inputPaintMs = await page.evaluate(() => performance.getEntriesByName("stream-input-paint")[0]?.duration);
  await testInfo.attach("streaming-metrics.json", { body: JSON.stringify({ modelCount, inputPaintMs, ...metrics }), contentType: "application/json" });
  // The old implementation committed roughly twice per block. Allow UI interactions and
  // machine scheduling variance while enforcing the planned 70% reduction.
  expect(metrics.commits).toBeGreaterThan(0);
  expect(metrics.commits).toBeLessThan(text.length * 2 * 0.3);
  expect(inputPaintMs).toBeDefined();
  expect(inputPaintMs!).toBeLessThan(100);
  await expect(page.locator(".markdown")).toHaveText(text);
  generation.status = "completed";
  generation.blocks = [{ id: "persisted", index: 0, stepIndex: 0, type: "text", content: text, complete: true }];
  await page.evaluate(() => {
    const probe = window as unknown as ProbeWindow;
    probe.sources.findLast((item) => item.url === "/api/generations/gen-1/events" && !item.closed)!
      .dispatchEvent(new MessageEvent("status", { data: JSON.stringify({ type: "status", generationId: "gen-1", status: "completed" }) }));
  });
  await expect(page.locator(".composer-stop-button")).toHaveCount(0);
  await expect(page.getByLabel("输入消息", { exact: true })).toHaveValue("生成中继续输入");
  await cdp.detach();
});
