// Shared E2E helpers: server API client and mobile-aware navigation.
import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";

export const APP_URL = process.env.E2E_APP_URL;
export const AUTH_URL = process.env.E2E_AUTH_URL;

export function initialPassword() {
  return JSON.parse(readFileSync(process.env.E2E_STATE_FILE, "utf8")).initialPassword;
}

/** Same-origin server API client that satisfies the mutation header rule. */
export async function api(request, baseUrl, method, path, body) {
  const response = await request.fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-llm-chat-request": "1" } : {})
    },
    data: body
  });
  if (response.status() === 204) return undefined;
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok()) {
    throw new Error(`${method} ${path} -> ${response.status()}: ${data?.error?.message ?? text}`);
  }
  return data;
}

/** Full agent payload for POST /api/agents, optionally bound to a model. */
export function agentInput(name, modelId = null) {
  return {
    card: {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name,
        description: "E2E 测试 Agent",
        personality: "",
        scenario: "",
        first_mes: "",
        mes_example: "",
        creator_notes: "",
        system_prompt: "",
        post_history_instructions: "",
        alternate_greetings: [],
        tags: [],
        creator: "",
        character_version: "",
        extensions: {}
      }
    },
    execution: {
      modelId,
      contextPolicy: "trim",
      // Discovered openai-chat models do not advertise reasoning support.
      reasoningEffort: "none",
      generation: {},
      tools: { defaultEnabled: true, overrides: {}, directOverrides: {}, approvalOverrides: {} },
      enabledSkillIds: [],
      maxToolRounds: 32,
      maxBackgroundTasks: 2,
      taskLogLimitBytes: 64 * 1024 * 1024
    },
    userProfile: {}
  };
}

/** On mobile viewports the sidebar is a drawer; open it when the toggle is visible. */
export async function openDrawerIfNeeded(page) {
  if (await page.locator(".mobile-drawer .workspace-sidebar").isVisible()) return;
  const toggle = page.getByRole("button", { name: "打开导航" });
  if (await toggle.isVisible()) {
    await toggle.click();
    await expect(page.locator(".mobile-drawer .workspace-sidebar")).toBeVisible();
  }
}

export async function gotoPath(page, path) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-frame")).toBeVisible();
}
