import { test, expect, type Page, type APIRequestContext } from "./fixtures";
import { agentInput, api, APP_URL, openDrawerIfNeeded } from "./helpers.mjs";
import { heavyHistory, heavyProfiles, type HeavyProfile } from "./heavy-history";
import { writeFile } from "node:fs/promises";

test.use({ serviceWorkers: "block", trace: "off", video: "off" });

async function setup(page: Page, request: APIRequestContext, profile: HeavyProfile) {
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`匿名重历史 ${profile.name}`));
  const heavy = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id, title: `重历史 ${profile.name}` });
  const short = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id, title: "短历史" });
  const messages = heavyHistory(profile);
  await page.addInitScript(() => localStorage.setItem("llm-chat.offline-enabled", "false"));
  await page.route(`**/api/conversations/${heavy.id}/messages`, route => route.fulfill({ json: messages }));
  await page.route("**/api/bootstrap*", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), messages: [] } });
  });
  await page.goto(`${APP_URL}/c/${short.id}`);
  await expect(page.getByLabel("输入消息", { exact: true })).toBeEditable();
  return { heavy, short, messages };
}

for (const profile of heavyProfiles) {
  test(`${profile.name} 少量重消息按视口挂载，折叠工具按需加载并保留原始模式`, async ({ page, request, isMobile }) => {
    const { heavy, short, messages } = await setup(page, request, profile);
    await openDrawerIfNeeded(page);
    await page.locator(`.conversation-row a[href="/c/${heavy.id}"]`).click();
    await expect(page.locator('.message-virtual-row').last()).toHaveAttribute('data-index', String(profile.messageCount - 1));
    await expect(page.locator('.msg').last()).toContainText('最新回复');
    await expect(page.getByLabel("输入消息", { exact: true })).toBeEditable();
    expect(await page.locator('.msg').count()).toBeLessThan(profile.messageCount);
    await expect(page.locator('.process-reasoning, .tool-presentation')).toHaveCount(0);
    const scroller = page.getByLabel('消息列表', { exact: true });
    await scroller.hover({ position: { x: 5, y: 5 } });
    await page.mouse.wheel(0, -100);
    await expect(scroller).not.toHaveAttribute('data-following-bottom', 'true');
    await scroller.evaluate(element => { element.scrollTop = 0; });
    const process = page.locator('.process-disclosure').filter({ hasText: '次工具调用' }).first();
    await process.locator(':scope > summary').click();
    const tool = process.locator('.tool-call').first();
    await expect(tool).toBeVisible();
    await expect(page.locator('.tool-presentation')).toHaveCount(0);
    await tool.locator(':scope > summary').click();
    await expect(tool.locator('.tool-presentation')).toBeVisible();
    const raw = tool.getByRole('button', { name: '查看原始数据', exact: true });
    await raw.click();
    await expect(tool.getByRole('button', { name: '查看格式化内容', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await tool.locator(':scope > summary').click();
    await expect(tool).not.toHaveAttribute('open');
    await tool.locator(':scope > summary').click();
    await expect(tool.getByRole('button', { name: '查看格式化内容', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
    await expect(page.locator('.msg').last()).toContainText('最新回复');
    // Cached contents and editable controls survive reads which have not returned.
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let reads = 0, delivered = 0;
    for (const conversation of [heavy, short]) await page.route(`**/api/conversations/${conversation.id}/messages`, async route => {
      reads++; await pending; delivered++;
      await route.fulfill({ json: conversation.id === heavy.id ? messages : [] }).catch(() => {});
    });
    try {
      await openDrawerIfNeeded(page);
      await page.locator(`.conversation-row a[href="/c/${short.id}"]`).click();
      if (isMobile) await expect(page.locator('.mobile-drawer')).toHaveCount(0);
      await page.getByLabel('输入消息', { exact: true }).fill('请求期间的短会话草稿');
      await openDrawerIfNeeded(page);
      await page.locator(`.conversation-row a[href="/c/${heavy.id}"]`).click();
      await expect(page.locator('.msg').last()).toContainText('最新回复');
      await page.getByLabel('输入消息', { exact: true }).fill('请求期间的重会话草稿');
      expect(delivered).toBe(0);
      await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
      release();
      await expect.poll(() => delivered).toBeGreaterThanOrEqual(2);
      await expect(page).toHaveURL(`${APP_URL}/c/${heavy.id}`);
      await expect(page.getByLabel('输入消息', { exact: true })).toHaveValue('请求期间的重会话草稿');
    } finally { release(); }
  });

  test(`${profile.name} 手机 4 倍 CPU 降速连续切换重历史 30 次`, async ({ page, request, browserName, isMobile }, testInfo) => {
    test.skip(browserName !== 'chromium' || !isMobile, '移动 Chromium 主线程和抽屉退出轨迹');
    test.setTimeout(150_000);
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      const { heavy, short } = await setup(page, request, profile);
      await page.evaluate(target => {
        const metrics = { clicks: [] as number[], navigation: [] as number[], frames: [] as number[], exits: [] as { start: number; end: number }[], longTasks: [] as { at: number; duration: number }[], prematureHistory: 0, recording: false };
        (window as any).__heavyMetrics = metrics;
        new PerformanceObserver(list => { for (const entry of list.getEntries()) metrics.longTasks.push({ at: entry.startTime, duration: entry.duration }); }).observe({ type: 'longtask' });
        document.addEventListener('pointerdown', () => {
          if (!metrics.recording) return;
          const at = performance.now();
          requestAnimationFrame(() => requestAnimationFrame(() => metrics.clicks.push(performance.now() - at)));
        }, { passive: true });
        document.addEventListener('click', event => {
          const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('.conversation-row a[href]') : null;
          if (!metrics.recording || !link || !link.href.endsWith(`/c/${target}`)) return;
          const start = performance.now();
          let painted = false, exitStarted = 0, previous = 0;
          const check = (at: number) => {
            const workspace = document.querySelector<HTMLElement>('.chat-workspace');
            const destination = workspace?.dataset.conversationId === target;
            const input = workspace?.querySelector<HTMLTextAreaElement>('textarea');
            if (destination && input && !input.disabled && !input.readOnly && !painted) {
              painted = true;
              requestAnimationFrame(() => metrics.navigation.push(performance.now() - start));
            }
            if (destination && document.querySelector('.mobile-drawer')) {
              if (!exitStarted) exitStarted = performance.now();
              if (previous) metrics.frames.push(at - previous);
              previous = at;
              if (workspace?.querySelector('.msg')) metrics.prematureHistory++;
            } else if (exitStarted) {
              metrics.exits.push({ start: exitStarted, end: performance.now() });
              return;
            }
            if (performance.now() - start < 2_000) requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        }, { capture: true });
      }, heavy.id);
      const press = async (selector: string) => {
        const point = await page.locator(selector).first().evaluate(element => { const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      const navigate = async (id: string, recording: boolean) => {
        await press('.conversation-header .shell-control');
        await page.waitForFunction(() => { const panel = document.querySelector('.drawer-panel'); return panel && getComputedStyle(panel).transform === 'none'; });
        await page.evaluate(value => { (window as any).__heavyMetrics.recording = value; }, recording);
        await press(`.conversation-row a[href="/c/${id}"]`);
        await page.waitForFunction(destination => document.querySelector<HTMLElement>('.chat-workspace')?.dataset.conversationId === destination && !document.querySelector('.mobile-drawer'), id);
        await page.evaluate(() => { (window as any).__heavyMetrics.recording = false; });
      };
      await navigate(heavy.id, false);
      await expect(page.locator('.msg').last()).toContainText('最新回复');
      for (let repeat = 0; repeat < 30; repeat++) {
        await navigate(short.id, false);
        await navigate(heavy.id, true);
        await page.waitForFunction(index => document.querySelector(`.message-virtual-row[data-index="${index}"]`), profile.messageCount - 1);
      }
      const metrics = await page.evaluate(() => (window as any).__heavyMetrics);
      const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * .95)] ?? 0;
      const exitTasks = metrics.longTasks.filter((task: { at: number; duration: number }) => metrics.exits.some((exit: { start: number; end: number }) => task.at < exit.end && task.at + task.duration > exit.start));
      const summary = { profile, cpuThrottle: 4, repetitions: 30, clickP95: p95(metrics.clicks), navigationP95: p95(metrics.navigation), exitFrameP95: p95(metrics.frames), exitTasks, ...metrics,
        note: 'Desktop mobile simulation; Android device frame rate is not measured.' };
      await writeFile(testInfo.outputPath('heavy-performance.json'), JSON.stringify(summary, null, 2));
      await testInfo.attach('heavy-performance.json', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' });
      expect(metrics.navigation).toHaveLength(30);
      expect(metrics.exits).toHaveLength(30);
      expect(metrics.prematureHistory).toBe(0);
      expect(summary.clickP95).toBeLessThan(100);
      expect(summary.navigationP95).toBeLessThan(100);
      expect(exitTasks).toHaveLength(0);
    } finally { await cdp.detach(); }
  });
}
