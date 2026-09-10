import { test as base } from "@playwright/test";
import { readFile } from "node:fs/promises";
export { expect, type Page, type APIRequestContext } from "@playwright/test";
export const test = base.extend<{ showTour: boolean }>({
  showTour: [false, { option: true }],
  storageState: async ({}, use) => {
    const deadline = Date.now() + 20_000;
    while (true) {
      let token: string | undefined;
      try { token = JSON.parse(await readFile(process.env.E2E_STATE_FILE!, "utf8")).appCookie; } catch {}
      if (token) {
        await use({ cookies: [{ name: "llm_chat_session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Strict", expires: -1 }], origins: [] });
        return;
      }
      if (Date.now() > deadline) throw new Error("Timed out waiting for the authenticated app fixture");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  },
  context: async ({ context, showTour }, use) => {
    if (!showTour) await context.addInitScript(() => { if (window === window.top) localStorage.setItem("llm-chat.quick-tour.v1", "seen"); });
    await use(context);
  }
});
