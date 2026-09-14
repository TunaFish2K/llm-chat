import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";
import { expectModelPickerInsideViewport } from "./model-picker-layout";

const allViewports = [
  { width: 320, height: 568 }, { width: 360, height: 640 }, { width: 390, height: 844 },
  { width: 844, height: 390 }, { width: 768, height: 1024 }, { width: 1024, height: 768 },
  { width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 390, height: 320 }
];

test("model pickers fit small screens, landscape and changing viewport heights", async ({ page, request }, info) => {
  test.setTimeout(180_000);
  const viewports = info.project.name === "chromium" ? allViewports : [allViewports[0]!, allViewports[3]!, allViewports[8]!];
  const connection = await api(request, APP_URL, "POST", "/api/connections", {
    name: "Overflow test", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", secretHeaders: {}
  });
  const models = [];
  for (let index = 0; index < 30; index++) models.push(await api(request, APP_URL, "POST", "/api/models", {
    connectionId: connection.id, modelKey: `vision-${index}`, displayName: `Vision ${String(index).padStart(2, "0")} ` + "long model name ".repeat(8),
    contextWindow: 128000, maxOutputTokens: 4096, capabilities: { imageInput: true, imageOutput: true, tools: true, reasoning: true },
    defaultSettings: { common: { maxOutputTokens: 4096, stopSequences: [] }, protocol: {} }, enabled: true
  }));
  const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput("Overflow Agent"));
  const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: agent.id, executionOverrides: { modelId: models[0].id } });
  const panel = page.locator(".model-picker-popover");
  const search = panel.getByRole("searchbox");
  const rows = panel.locator(".model-group").filter({ has: page.getByRole("heading", { name: connection.name, exact: true }) }).locator(".model-option");
  const checkSearch = async () => {
    await expectModelPickerInsideViewport(page);
    await expect(rows).toHaveCount(30);
    await search.fill("Vision");
    await expectModelPickerInsideViewport(page);
    await search.fill("no matches");
    await expect(rows).toHaveCount(0);
    await expectModelPickerInsideViewport(page);
    await search.fill("");
    await expect(rows).toHaveCount(30);
    await expectModelPickerInsideViewport(page);
  };
  try {
    for (const viewport of viewports) await test.step(`${viewport.width}×${viewport.height}`, async () => {
      await page.setViewportSize(viewport);
      await page.goto(`/agents/${agent.id}`);
      await page.getByRole("tab", { name: "执行配置", exact: true }).click();
      for (const label of ["模型", "备用识图模型"]) {
        const trigger = page.getByRole("button", { name: label, exact: true });
        for (const fraction of [0.2, 0.55, 0.8]) {
          await trigger.evaluate((element, fraction) => {
            const scroll = element.closest(".panel-scroll")!;
            scroll.scrollTop += element.getBoundingClientRect().top - innerHeight * fraction;
          }, fraction);
          await trigger.click();
          await expect(search).toHaveValue("");
          await checkSearch();
          await panel.getByRole("button", { name: "关闭模型选择" }).click();
          await expect(panel).toHaveCount(0);
        }
        await trigger.click();
        await rows.last().click();
        await expect(panel).toHaveCount(0);
        await expect(trigger).toContainText("Vision 29");
        await trigger.click();
        await expect(search).toHaveValue("");
        await expectModelPickerInsideViewport(page);
        await page.keyboard.press("Escape");
      }
      const save = page.getByRole("button", { name: "保存修改", exact: true });
      if (await save.count()) {
        await save.click();
        await expect(page.getByRole("button", { name: "已保存", exact: true })).toBeDisabled();
      }
      await page.goto(`/c/${conversation.id}`);
      const trigger = page.getByRole("button", { name: "选择模型", exact: true });
      await trigger.click();
      await checkSearch();
      await page.setViewportSize({ width: viewport.height, height: viewport.width });
      await expectModelPickerInsideViewport(page);
      await page.setViewportSize({ width: 390, height: 320 });
      await expectModelPickerInsideViewport(page);
      await search.fill("Vision");
      await expectModelPickerInsideViewport(page);
      await page.screenshot({ animations: "disabled", path: info.outputPath(`picker-${viewport.width}-${viewport.height}-reduced-height.png`) });
      await rows.last().click();
      await expect(panel).toHaveCount(0);
      await expect.poll(async () => (await api(request, APP_URL, "GET", `/api/conversations/${conversation.id}`)).modelId).toBe(models[29].id);
    });
  } finally {
    await page.goto("about:blank");
    await api(request, APP_URL, "DELETE", `/api/conversations/${conversation.id}`);
    await api(request, APP_URL, "DELETE", `/api/agents/${agent.id}`);
    await api(request, APP_URL, "DELETE", `/api/connections/${connection.id}`);
  }
});
