import { expect, test } from "./fixtures";
import { agentInput, api, APP_URL } from "./helpers.mjs";

test.use({ serviceWorkers: "block" });
for (const locale of ["zh-CN", "en-US"] as const) test.describe(locale, () => {
  test.use({ locale });
  const cn = locale === "zh-CN";
  test("preload controls and text links follow the theme and preserve navigation guards", async ({ page, request }) => {
    const agent = await api(request, APP_URL, "POST", "/api/agents", agentInput(`Appearance ${crypto.randomUUID()}`));
    const catalog = await api(request, APP_URL, "GET", "/api/container-resources");
    const source = catalog.resources[0];
    const longName = "Optional software " + "very-long-package-name-".repeat(8);
    const additions = [
      { ...source, id: "plugin:appearance:available", available: true, definition: { ...source.definition, name: longName } },
      { ...source, id: "plugin:appearance:unavailable", available: false, definition: { ...source.definition, name: "Unavailable software" } }
    ];
    await page.route("**/api/container-resources", route => route.fulfill({ json: { ...catalog, resources: [...catalog.resources, ...additions] } }));
    await page.goto(`/agents/${agent.id}`);
    await page.getByRole("tab", { name: cn ? "执行配置" : "Execution settings", exact: true }).click();
    await page.getByLabel(cn ? "执行环境" : "Execution environment", { exact: true }).selectOption("container");
    const group = page.getByRole("group", { name: cn ? "预载软件" : "Preload software", exact: true });
    const common = group.getByRole("checkbox", { name: cn ? "常用工具" : "Common tools", exact: true });
    await expect(common).toBeChecked();
    await expect(group.getByRole("checkbox", { name: "Unavailable software", exact: true })).toBeDisabled();
    await expect(group.getByRole("checkbox", { name: longName, exact: true })).toBeEnabled();
    const link = group.getByRole("link");
    for (const theme of ["light", "dark"]) for (const accent of ["#c64b2f", "#7855cc"]) {
      await page.evaluate(({ theme, accent }) => { document.documentElement.dataset.theme = theme; document.documentElement.style.setProperty("--accent", accent); }, { theme, accent });
      const colors = await link.evaluate(element => {
        const computed = getComputedStyle(element), box = element.closest("fieldset")!, checkbox = box.querySelector("input")!;
        const probe = document.createElement("span"); probe.style.color = "var(--accent)"; document.body.append(probe);
        const accent = getComputedStyle(probe).color; probe.style.color = "var(--border)"; const border = getComputedStyle(probe).color; probe.remove();
        return { color: computed.color, underline: computed.textDecorationColor, checkbox: getComputedStyle(checkbox).accentColor, border: getComputedStyle(box).borderTopColor, radius: parseFloat(getComputedStyle(box).borderRadius), accent, expectedBorder: border };
      });
      expect(colors.color).toBe(colors.accent); expect(colors.underline).toBe(colors.accent); expect(colors.checkbox).toBe(colors.accent);
      expect(colors.border).toBe(colors.expectedBorder); expect(colors.radius).toBeGreaterThan(0);
      expect(await group.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await page.screenshot({ path: test.info().outputPath("preload-controls.png"), animations: "disabled" });
    await common.focus(); await page.keyboard.press("Space"); await expect(common).not.toBeChecked();
    await page.keyboard.press("Space"); await expect(common).toBeChecked();
    await page.getByRole("button", { name: cn ? "保存修改" : "Save changes", exact: true }).click();
    await expect(page.getByRole("button", { name: cn ? "已保存" : "Saved", exact: true })).toBeDisabled();
    await page.reload(); await page.getByRole("tab", { name: cn ? "执行配置" : "Execution settings", exact: true }).click();
    await expect(common).toBeChecked();
    await common.uncheck();
    await link.click();
    const confirmation = page.getByRole("dialog"); await expect(confirmation).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}$`));
    await confirmation.getByRole("button", { name: cn ? "取消" : "Cancel", exact: true }).click();
    await expect(common).not.toBeChecked();
    await page.getByRole("button", { name: cn ? "保存修改" : "Save changes", exact: true }).click();
    await expect(page.getByRole("button", { name: cn ? "已保存" : "Saved", exact: true })).toBeDisabled();
    await page.evaluate(() => { (window as unknown as { navigationMarker: boolean }).navigationMarker = true; });
    await link.focus(); await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/settings\/container-resources$/);
    expect(await page.evaluate(() => (window as unknown as { navigationMarker?: boolean }).navigationMarker)).toBe(true);
    await page.getByText(cn ? "资源文件" : "Resource files", { exact: false }).first().click();
    const download = page.locator(".container-resource-files a").first();
    await expect(download).toHaveAttribute("target", "_blank"); await expect(download).toHaveClass("text-link");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("resource-links.png"), animations: "disabled" });
  });
});
