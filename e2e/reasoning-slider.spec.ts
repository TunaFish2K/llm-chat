import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";

for (const locale of ["zh-CN", "en-US"] as const) {
  test.describe(locale, () => {
    test.use({ locale, serviceWorkers: "block" });
    test("vertical native slider previews a drag, commits on release and preserves focus and draft", async ({ page, request, context }) => {
      const connection = await api(request, APP_URL, "POST", "/api/connections", { name: "Slider", protocol: "openai-chat", baseUrl: "https://example.invalid/v1", secretHeaders: {} });
      const model = await api(request, APP_URL, "POST", "/api/models", {
        connectionId: connection.id, modelKey: "native-slider", displayName: "Slider model", contextWindow: 128000, maxOutputTokens: 4096,
        reasoningEffortsOverride: ["low", "medium", "high", "xhigh"], capabilities: { reasoning: true },
        defaultSettings: { common: { maxOutputTokens: 4096, stopSequences: [] }, protocol: {} }, enabled: true
      });
      const input = agentInput("Slider agent", model.id);
      const agent = await api(request, APP_URL, "POST", "/api/agents", { ...input, execution: { ...input.execution, reasoningSelection: { mode: "default" } } });
      const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id });
      const mobile = test.info().project.name === "mobile-chromium";
      try {
        if (mobile) await page.setViewportSize({ width: 320, height: 640 });
        await page.goto(`/c/${conversation.id}`);
        const composer = page.locator(".composer textarea").first();
        await composer.fill("Keep my draft");
        await page.locator(".reasoning-trigger").click();
        const popover = page.locator(".reasoning-popover");
        const slider = popover.getByRole("slider");
        await expect(slider).toHaveAttribute("aria-orientation", "vertical");
        await expect(composer).not.toBeFocused();
        const changes: string[] = [];
        page.on("request", req => { if (req.method() === "PATCH" && req.url().endsWith(`/api/conversations/${conversation.id}`)) changes.push(req.postData() ?? ""); });
        const rail = (await page.locator(".reasoning-slider").boundingBox())!;
        const thumb = (await slider.boundingBox())!;
        const x = thumb.x + thumb.width / 2;
        const y = thumb.y + thumb.height / 2;
        const targetY = rail.y + rail.height * 0.2;
        const touch = mobile ? await context.newCDPSession(page) : null;
        if (touch) {
          await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
          await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: targetY }] });
        } else {
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x, targetY, { steps: 5 });
        }
        await expect(slider).toHaveAttribute("aria-valuetext", "high");
        expect(changes).toHaveLength(0);
        expect((await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}`)).executionOverrides.reasoningSelection).toBeUndefined();
        if (touch) await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        else await page.mouse.up();
        await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}`)).executionOverrides.reasoningSelection).toEqual({ mode: "effort", value: "high" });
        expect(changes).toHaveLength(1);
        await expect(popover).toBeVisible();
        await expect(slider).not.toHaveAttribute("aria-disabled");
        if (touch) {
          const currentThumb = (await slider.boundingBox())!;
          const touchX = currentThumb.x + currentThumb.width / 2;
          await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchX, y: currentThumb.y + currentThumb.height / 2 }] });
          await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: touchX, y: rail.y + rail.height * 0.4 }] });
          await expect(slider).toHaveAttribute("aria-valuetext", "medium");
          await touch.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
          await expect(slider).toHaveAttribute("aria-valuetext", "high");
          expect(changes).toHaveLength(1);
        }
        await slider.focus();
        await page.keyboard.press("End");
        await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}`)).executionOverrides.reasoningSelection).toEqual({ mode: "effort", value: "xhigh" });
        await expect(slider).toBeFocused();
        await expect(slider).not.toHaveAttribute("aria-disabled");
        await page.keyboard.press("Home");
        await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}`)).executionOverrides.reasoningSelection).toEqual({ mode: "default" });
        await expect(slider).not.toHaveAttribute("aria-disabled");
        await page.keyboard.press("ArrowUp");
        await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}`)).executionOverrides.reasoningSelection).toEqual({ mode: "effort", value: "low" });
        await expect(slider).not.toHaveAttribute("aria-disabled");
        await popover.getByRole("button", { name: "low", exact: true }).click();
        await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}`)).executionOverrides.reasoningSelection).toEqual({ mode: "effort", value: "low" });
        await expect(popover).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(composer).toHaveValue("Keep my draft");
        await expect(composer).not.toBeFocused();
        await expect(page.locator(".reasoning-trigger")).toBeFocused();
        await touch?.detach();

        const longLevels = Array.from({ length: 20 }, (_, index) => `${index + 1}-` + "native".repeat(10));
        await api(request, APP_URL, "PATCH", `/api/models/${model.id}`, { reasoningEffortsOverride: longLevels });
        await page.reload();
        await page.locator(".reasoning-trigger").click();
        await expect(popover.getByRole("alert")).toHaveCount(0);
        await expect(slider).toHaveAttribute("aria-valuetext", longLevels.at(-1)!);
        await expect(popover.locator("button[aria-pressed=true]")).toHaveCount(1);
        expect((await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}`)).executionOverrides.reasoningSelection).toEqual({ mode: "effort", value: "low" });
        const box = (await popover.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
        expect(await popover.evaluate(node => node.scrollHeight > node.clientHeight && node.scrollWidth <= node.clientWidth)).toBe(true);
        const nativeLabel = popover.getByRole("button", { name: longLevels[0], exact: true });
        await nativeLabel.scrollIntoViewIfNeeded();
        await nativeLabel.click();
        await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}`)).executionOverrides.reasoningSelection).toEqual({ mode: "effort", value: longLevels[0] });
        await expect(slider).toHaveAttribute("aria-valuetext", longLevels[0]);
        await expect(nativeLabel).toBeInViewport();
        const labelBox = (await nativeLabel.boundingBox())!;
        const newThumb = (await slider.boundingBox())!;
        expect(Math.abs(labelBox.y + labelBox.height / 2 - newThumb.y - newThumb.height / 2)).toBeLessThanOrEqual(11);
        await page.screenshot({ path: test.info().outputPath(`reasoning-slider-${locale}.png`) });
      } finally {
        await page.goto("about:blank");
        await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
        await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
        await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`);
      }
    });
  });
}
