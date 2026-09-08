import { test as base } from "@playwright/test";
export { expect, type Page, type APIRequestContext } from "@playwright/test";
export const test = base.extend<{ showTour: boolean }>({
  showTour: [false, { option: true }],
  context: async ({ context, showTour }, use) => {
    if (!showTour) await context.addInitScript(() => localStorage.setItem("llm-chat.quick-tour.v1", "seen"));
    await use(context);
  }
});
