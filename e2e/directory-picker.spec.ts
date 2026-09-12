import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import { api, APP_URL } from "./helpers.mjs";

for (const entry of ["settings", "chat"] as const) {
  test(`工作目录支持路径输入和错误恢复，打开时不聚焦输入框（${entry}）`, async ({ page, request }) => {
    const root = await mkdtemp(join(process.env.E2E_RUN_DIR!, "directory-picker-"));
    const target = join(root, "中文 project ");
    await mkdir(target);
    await symlink(target, join(root, "shortcut"));
    await writeFile(join(root, "file.txt"), "test");
    const previous = await api(request, APP_URL, "GET", "/api/settings");
    let conversationId: string | undefined;
    try {
      if (entry === "settings") {
        await api(request, APP_URL, "PATCH", "/api/settings", { lastWorkspacePath: root });
        await page.goto("/settings/general");
      } else {
        const conversation = await api(request, APP_URL, "POST", "/api/conversations", { agentId: previous.defaultAgentId, workspacePath: root });
        conversationId = conversation.id;
        await page.goto(`/c/${conversationId}`);
        await page.getByRole("button", { name: "低频设置" }).click();
      }
      await page.getByRole("button", { name: "选择工作目录", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "选择工作目录" });
      const input = dialog.getByRole("textbox", { name: "目录路径", exact: true });
      await expect(dialog).toBeVisible();
      await expect(input).not.toBeFocused();
      await expect(dialog.getByText(`当前目录：${root}`, { exact: true })).toBeVisible();
      await expect(input).not.toBeFocused();
      await expect(dialog.getByRole("textbox", { name: "新目录名称" })).not.toBeFocused();
      await expect(dialog.getByRole("button", { name: "关闭对话框" })).toBeFocused();

      if (test.info().project.name === "mobile-chromium") {
        await page.setViewportSize({ width: 320, height: 844 });
        const fits = await dialog.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const row = element.querySelector(".directory-path-row")!;
          return rect.left >= 0 && rect.right <= window.innerWidth && row.scrollWidth <= row.clientWidth;
        });
        expect(fits).toBe(true);
      }
      for (const [path, message] of [
        ["", "请输入目录路径"], ["relative/path", "必须是绝对路径"],
        [join(root, "missing"), "目录不存在"], [join(root, "file.txt"), "不是目录"]
      ]) {
        await input.fill(path!);
        await dialog.getByRole("button", { name: "打开", exact: true }).click();
        await expect(dialog.getByRole("alert")).toContainText(message!);
        await expect(input).toHaveValue(path!);
        await expect(dialog.getByText(`当前目录：${root}`, { exact: true })).toBeVisible();
        await expect(dialog.getByRole("button", { name: "使用当前目录" })).toBeDisabled();
        if (test.info().project.name === "mobile-chromium") await expect(input).not.toBeFocused();
      }
      await input.fill(join(root, "shortcut"));
      await input.press("Enter");
      await expect(input).toHaveValue(target);
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      await expect(dialog).toBeVisible();
      if (entry === "settings" && test.info().project.name === "mobile-chromium") {
        await page.screenshot({ path: test.info().outputPath("directory-picker-mobile.png") });
      }
      await dialog.getByRole("button", { name: "使用当前目录" }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(async () => {
        const result = await api(request, APP_URL, "GET", entry === "settings" ? "/api/settings" : `/api/conversations/${conversationId}`);
        return entry === "settings" ? result.lastWorkspacePath : result.workspacePath;
      }).toBe(target);
    } finally {
      if (conversationId) await api(request, APP_URL, "DELETE", `/api/conversations/${conversationId}`);
      if (entry === "settings") await api(request, APP_URL, "PATCH", "/api/settings", { lastWorkspacePath: previous.lastWorkspacePath });
      await rm(root, { recursive: true, force: true });
    }
  });
}
