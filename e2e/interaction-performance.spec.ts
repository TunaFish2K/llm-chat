import { test, expect } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";
import { startMockProvider } from "./mock-provider.mjs";
import type { MessageDto } from "@llm-chat/contracts";
import { open, readFile, writeFile } from "node:fs/promises";

test.use({ serviceWorkers: "block", trace: "off", video: "off" });

for (const size of [50, 500, 2_000]) {
  test(`生产构建交互轨迹：${size} 会话和 1000 条消息`, async ({ page, request, browserName, isMobile }, testInfo) => {
    test.skip(browserName !== "chromium", "Chromium CPU 与合成器轨迹");
    test.setTimeout(180_000);
    const provider = await startMockProvider({ responseText: "## 回复\n\n历史内容与 **重点**。\n\n```js\nconst value = 42;\n```\n\n| 项目 | 值 |\n| --- | --- |\n| 状态 | 已完成 |" });
    const cdp = await page.context().newCDPSession(page);
    let tracing = false;
    let releaseMessages: (() => void) | undefined;
    try {
      const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "Performance", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
      const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
      const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("性能测量", model.id));
      const started = await api(request, APP_URL, "POST", "/api/conversations/start", { agentId: agent.id, text: "历史消息" });
      await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/generations/${started.generation.generationId}`)).status).toBe("completed");
      const short = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id, title: "短会话" });
      const seed = await api(request, APP_URL, "GET", `/api/conversations/${started.conversation.id}/messages`) as MessageDto[];
      const user = seed.find(message => message.role === "user")!, assistant = seed.find(message => message.role === "assistant" && message.generations.length)!;
      const messages = Array.from({ length: 1_000 }, (_, index) => ({ ...(index % 2 ? assistant : user), id: `history-${index}`, ordinal: index + 1 }));
      const conversations = [started.conversation, short, ...Array.from({ length: size - 2 }, (_, index) => ({ ...short, id: `sidebar-${index}`, title: `会话 ${index}`, activeBranchId: `sidebar-${index}` }))];
      await page.addInitScript(() => localStorage.setItem("llm-chat.offline-enabled", "false"));
      await page.route("**/api/bootstrap*", async route => {
        const response = await route.fetch(); const data = await response.json();
        await route.fulfill({ response, json: { ...data, conversations, messages } });
      });
      await page.route("**/api/conversations", route => route.request().method() === "GET" ? route.fulfill({ json: conversations }) : route.continue());
      await page.route(`**/api/conversations/${started.conversation.id}/messages`, route => route.fulfill({ json: messages }));
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await page.goto(`${APP_URL}/c/${started.conversation.id}`);
      await expect(page.getByLabel("输入消息", { exact: true })).toBeEditable({ timeout: process.env.MOTION_BASELINE ? 90_000 : 10_000 });
      await expect(page.locator(".msg").last()).toContainText("历史内容");
      await page.evaluate(() => {
        const metrics = { frames: [] as number[], longTasks: [] as { at: number; duration: number }[], clicks: [] as number[], navigation: [] as number[], navigationSteps: [] as { route: number; ready: number; paint: number }[], windows: [] as { start: number; end: number }[], recording: false, started: 0, previous: 0 };
        (window as any).__interactionMetrics = metrics;
        new PerformanceObserver(list => { for (const entry of list.getEntries()) metrics.longTasks.push({ at: entry.startTime, duration: entry.duration }); }).observe({ type: "longtask", buffered: false });
        const frame = (at: number) => {
          if (metrics.recording && metrics.previous) metrics.frames.push(at - metrics.previous);
          metrics.previous = metrics.recording ? at : 0;
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        document.addEventListener("pointerdown", () => {
          if (!metrics.recording) return;
          const at = performance.now();
          requestAnimationFrame(() => requestAnimationFrame(() => metrics.clicks.push(performance.now() - at)));
        }, { passive: true });
        document.addEventListener("click", event => {
          const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('.conversation-row a[href]') : null;
          if (!metrics.recording || !link) return;
          const target = new URL(link.href).pathname.split('/')[2];
          const at = performance.now();
          let routeAt = at;
          const changed = () => { if (location.pathname.split('/')[2] === target) routeAt = performance.now(); };
          window.addEventListener("popstate", changed);
          const check = () => {
            const workspace = document.querySelector<HTMLElement>('.chat-workspace');
            const input = workspace?.querySelector<HTMLTextAreaElement>('textarea');
            if (workspace?.dataset.conversationId === target && input && !input.disabled && !input.readOnly) {
              const readyAt = performance.now();
              window.removeEventListener("popstate", changed);
              requestAnimationFrame(() => {
                const paint = performance.now() - at;
                metrics.navigation.push(paint);
                metrics.navigationSteps.push({ route: routeAt - at, ready: readyAt - at, paint });
              });
            } else if (performance.now() - at < 5_000) requestAnimationFrame(check);
            else window.removeEventListener("popstate", changed);
          };
          requestAnimationFrame(check);
        }, { capture: true });
      });
      await cdp.send("Profiler.enable"); await cdp.send("Profiler.start");
      await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline.frame,cc", transferMode: "ReturnAsStream" });
      tracing = true;
      const press = async (selector: string, settle = isMobile ? 500 : 220) => {
        const point = await page.locator(selector).first().evaluate(element => { const box = element.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; });
        if (isMobile) {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } else {
          await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
        }
        if (settle) await page.waitForTimeout(settle);
      };
      // Capture diagnostics during two warm-up rounds; profiler overhead is not latency.
      for (let repeat = 0; repeat < 32; repeat++) {
        await page.evaluate(recording => { const metrics = (window as any).__interactionMetrics; metrics.recording = recording; metrics.started = performance.now(); }, repeat >= 2);
        if (isMobile) {
          await press('.conversation-header .shell-control');
          await expect(page.locator(".drawer-panel")).toHaveCSS("transform", "none");
          await expect(page.locator(".conversation-scroll")).toBeVisible();
          if (!process.env.MOTION_BASELINE && size > 40) {
            await expect(page.locator(".conversation-scroll")).toHaveAttribute("data-virtual", "true");
            expect(await page.locator(".conversation-row").count()).toBeLessThan(40);
          }
          if (repeat === 0) {
            await page.screenshot({ path: testInfo.outputPath("drawer.png") });
            await testInfo.attach("drawer.png", { path: testInfo.outputPath("drawer.png"), contentType: "image/png" });
          }
          await press('.drawer-panel .sidebar-header-actions button:last-child');
          await expect(page.locator(".mobile-drawer")).toHaveCount(0);
        } else {
          await press('.sidebar-collapse-button');
          await press('.sidebar-brand-button');
        }
        if (repeat < 17) {
          if (isMobile) await press('.conversation-header .shell-control');
          await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 0; });
          const shortLink = `.conversation-row a[href="/c/${short.id}"]`;
          await expect(page.locator(shortLink)).toBeVisible();
          await press(shortLink, 0);
          // Failed assertion polls build an accessibility tree; keep them out of latency.
          if (repeat >= 2) await page.waitForFunction(count => (window as any).__interactionMetrics.navigation.length >= count, (repeat - 2) * 2 + 1);
          await expect(page).toHaveURL(`${APP_URL}/c/${short.id}`);
          if (isMobile) {
            await expect(page.locator('.mobile-drawer')).toHaveCount(0);
            await press('.conversation-header .shell-control');
          }
          await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
          const longLink = `.conversation-row a[href="/c/${started.conversation.id}"]`;
          await expect(page.locator(longLink)).toBeVisible();
          await press(longLink, 0);
          if (repeat >= 2) await page.waitForFunction(count => (window as any).__interactionMetrics.navigation.length >= count, (repeat - 2) * 2 + 2);
          await expect(page).toHaveURL(`${APP_URL}/c/${started.conversation.id}`);
          await expect(page.locator('.msg').last()).toContainText("历史内容");
          expect(await page.locator('.msg').count()).toBeLessThan(24);
          if (isMobile) await expect(page.locator('.mobile-drawer')).toHaveCount(0);
        }
        await page.evaluate(() => { const metrics = (window as any).__interactionMetrics; if (metrics.recording) metrics.windows.push({ start: metrics.started, end: performance.now() }); metrics.recording = false; metrics.previous = 0; });
        if (repeat === 1) {
          const ended = new Promise<string>(resolve => cdp.once("Tracing.tracingComplete", event => resolve(event.stream!)));
          await cdp.send("Tracing.end"); const handle = await ended; tracing = false;
          const file = await open(testInfo.outputPath("compositor-trace.json"), "w");
          try {
            while (true) {
              const chunk = await cdp.send("IO.read", { handle, size: 65_536 });
              await file.write(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"));
              if (chunk.eof) break;
            }
          } finally { await file.close(); await cdp.send("IO.close", { handle }); }
          await testInfo.attach("compositor-trace.json", { path: testInfo.outputPath("compositor-trace.json"), contentType: "application/json" });
          const profile = await cdp.send("Profiler.stop");
          await writeFile(testInfo.outputPath("cpu-profile.json"), JSON.stringify(profile));
          await testInfo.attach("cpu-profile.json", { path: testInfo.outputPath("cpu-profile.json"), contentType: "application/json" });
        }
      }
      await page.keyboard.press("Tab");
      await page.screenshot({ path: testInfo.outputPath("chat.png") });
      await testInfo.attach("chat.png", { path: testInfo.outputPath("chat.png"), contentType: "image/png" });
      await expect(page.getByLabel("输入消息", { exact: true })).toBeEditable();
      const metrics = await page.evaluate(() => (window as any).__interactionMetrics) as { frames: number[]; clicks: number[]; navigation: number[]; navigationSteps: Array<{ route: number; ready: number; paint: number }>; windows: Array<{ start: number; end: number }>; longTasks: Array<{ at: number; duration: number }> };
      const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * .95)] ?? 0;
      const animationTasks = metrics.longTasks.filter(task => metrics.windows.some(window => task.at >= window.start && task.at < window.end));
      const summary = { baseline: Boolean(process.env.MOTION_BASELINE), size, messageCount: 1_000, mobile: isMobile, cpuThrottle: 4, repetitions: 30,
        frameP95: p95(metrics.frames), slowFrameRatio: metrics.frames.filter(frame => frame > 33).length / metrics.frames.length,
        clickPaintUpperBoundP95: p95(metrics.clicks), navigationPaintP95: p95(metrics.navigation), navigationSamples: metrics.navigation, navigationSteps: metrics.navigationSteps, animationTasks, browser: await cdp.send("Browser.getVersion"),
        note: "Desktop simulation; click metric bounds two animation frames, compositor trace attached. Real device thermal and battery measurements are separate." };
      await testInfo.attach("performance.json", { body: JSON.stringify(summary, null, 2), contentType: "application/json" });
      await writeFile(testInfo.outputPath("performance.json"), JSON.stringify(summary, null, 2));
      expect(metrics.frames.length).toBeGreaterThan(30);
      if (!process.env.MOTION_BASELINE) expect(summary.clickPaintUpperBoundP95).toBeLessThan(100);
      if (!process.env.MOTION_BASELINE) {
        expect(metrics.navigation.length).toBe(30);
        expect(summary.navigationPaintP95).toBeLessThan(100);
      }
      expect(JSON.parse(await readFile(testInfo.outputPath("compositor-trace.json"), "utf8")).traceEvents.length).toBeGreaterThan(0);
      if (!process.env.MOTION_BASELINE) {
        const delayed = new Promise<void>(resolve => { releaseMessages = resolve; });
        let reads = 0, delivered = 0;
        for (const conversation of [short, started.conversation]) {
          await page.route(`**/api/conversations/${conversation.id}/messages`, async route => {
            reads++; await delayed; delivered++;
            await route.fulfill({ json: conversation.id === short.id ? [] : messages }).catch(() => {});
          });
        }
        if (isMobile) await press('.conversation-header .shell-control');
        await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 0; });
        const shortLink = `.conversation-row a[href="/c/${short.id}"]`;
        await expect(page.locator(shortLink)).toBeVisible();
        await page.locator(shortLink).click();
        await expect(page).toHaveURL(`${APP_URL}/c/${short.id}`);
        const input = page.getByLabel("输入消息", { exact: true });
        await expect(input).toBeEditable(); await input.fill("慢请求期间继续输入");
        expect(delivered).toBe(0);
        if (isMobile) {
          await expect(page.locator('.mobile-drawer')).toHaveCount(0);
          await press('.conversation-header .shell-control');
        }
        await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
        const longLink = `.conversation-row a[href="/c/${started.conversation.id}"]`;
        await expect(page.locator(longLink)).toBeVisible(); await page.locator(longLink).click();
        await expect(page).toHaveURL(`${APP_URL}/c/${started.conversation.id}`);
        await expect(page.locator('.msg').last()).toContainText("历史内容");
        await expect(page.getByLabel("输入消息", { exact: true })).toBeEditable();
        expect(delivered).toBe(0);
        await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
        await page.waitForTimeout(3_000); releaseMessages!();
        await expect.poll(() => delivered).toBeGreaterThanOrEqual(2);
        await expect(page).toHaveURL(`${APP_URL}/c/${started.conversation.id}`);
        await testInfo.attach("cached-navigation.json", { body: JSON.stringify({ delayMs: 3_000, reads, inputEditableBeforeResponse: true, cachedHistoryVisibleBeforeResponse: true }), contentType: "application/json" });
      }
    } finally {
      releaseMessages?.();
      if (tracing) await cdp.send("Tracing.end").catch(() => {});
      await cdp.detach().catch(() => {}); await page.goto("about:blank").catch(() => {}); await provider.close();
    }
  });
}

test("新会话先显示提交状态，通知确认后跳转，HTTP 未返回仍可继续输入", async ({ page, request }) => {
  const provider = await startMockProvider({ responseText: "已收到" });
  let release!: () => void;
  let send: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "Acceptance", protocol: "openai-chat", baseUrl: provider.baseUrl, secretHeaders: {} });
    const model = (await api(request, APP_URL, "POST", `/api/connections/${connection.id}/models/discover`)).created[0];
    const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("即时确认", model.id));
    await api(request, APP_URL, "PATCH", "/api/settings", { defaultAgentId: agent.id, lastAgentId: agent.id });
    let responseReturned = false;
    const beforeWrite = new Promise<void>(resolve => { send = resolve; });
    await page.route("**/api/conversations/*/messages", async route => {
      if (route.request().method() === "GET") await gate;
      await route.continue().catch(() => {});
    });
    await page.route("**/api/conversations/start", async route => {
      await beforeWrite;
      const response = await route.fetch();
      await gate; responseReturned = true;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.goto(APP_URL);
    const input = page.getByLabel("输入消息", { exact: true });
    await input.fill("即时提交");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".pending-message")).toContainText("即时提交");
    await expect(page.locator(".welcome")).toHaveCount(0);
    await input.fill("下一条草稿");
    send!();
    await expect(page).toHaveURL(/\/c\//);
    expect(responseReturned).toBe(false);
    await expect(page.locator('.msg[data-role="user"]')).toContainText("即时提交");
    await expect(page.getByLabel("输入消息", { exact: true })).toHaveValue("下一条草稿");
    await expect(page.locator(".pending-message")).toHaveCount(0);
    release();
  } finally { send?.(); release(); await page.goto("about:blank"); await provider.close(); }
});
