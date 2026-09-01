import { readFile } from "node:fs/promises";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

interface BootstrapPayload {
  settings: { defaultAgentId: string };
  agents: Array<{ id: string; protected: boolean }>;
  connections: Array<{ id: string; name: string }>;
  models: Array<{ id: string; connectionId: string; displayName: string }>;
  conversations: Array<{ id: string; title: string }>;
}

interface SupervisorState {
  appUrl: string;
  authUrl: string;
  initialPassword: string;
}

export async function ensureChatFixture(request: APIRequestContext): Promise<{ conversationId: string }> {
  let boot = await json<BootstrapPayload>(await request.get("/api/bootstrap"));
  let connection = boot.connections.find((item) => item.name === "E2E local connection");
  if (!connection) {
    connection = await json<{ id: string; name: string }>(await request.post("/api/connections", {
      data: {
        name: "E2E local connection",
        protocol: "openai-chat",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "e2e-unused-key",
        secretHeaders: {}
      }
    }));
  }

  let model = boot.models.find((item) => item.connectionId === connection.id && item.displayName === "E2E Model");
  if (!model) {
    model = await json<{ id: string; connectionId: string; displayName: string }>(await request.post("/api/models", {
      data: {
        connectionId: connection.id,
        modelKey: "e2e-model",
        displayName: "E2E Model",
        contextWindow: 8192,
        maxOutputTokens: 512,
        capabilities: {
          tools: true,
          temperature: true,
          topP: true,
          reasoning: false,
          reasoningSummary: false,
          adaptiveThinking: false,
          manualThinking: false
        },
        defaultSettings: {
          common: { maxOutputTokens: 512, stopSequences: [] },
          protocol: {}
        },
        enabled: true
      }
    }));
  }

  boot = await json<BootstrapPayload>(await request.get("/api/bootstrap"));
  let conversation = boot.conversations.find((item) => item.title === "E2E layout conversation");
  if (!conversation) {
    const agentId = boot.agents.find((item) => item.protected)?.id ?? boot.settings.defaultAgentId;
    conversation = await json<{ id: string; title: string }>(await request.post("/api/conversations", {
      data: {
        title: "E2E layout conversation",
        agentId,
        executionOverrides: { modelId: model.id },
        workspacePath: null
      }
    }));
  }
  return { conversationId: conversation.id };
}

export async function openChat(page: Page, request: APIRequestContext): Promise<{ conversationId: string }> {
  const fixture = await ensureChatFixture(request);
  await page.goto(`/c/${fixture.conversationId}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByPlaceholder("输入消息")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return fixture;
}

export function recordPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    const knownWebKitViewportDiagnostic = message.text()
      === 'Viewport argument key "interactive-widget" not recognized and ignored.';
    if (message.type() === "error" && !knownWebKitViewportDiagnostic) errors.push(`console: ${message.text()}`);
  });
  return errors;
}

export async function expectNoOverlap(left: Locator, right: Locator, label: string): Promise<void> {
  const [leftBox, rightBox] = await Promise.all([left.boundingBox(), right.boundingBox()]);
  expect(leftBox, `${label}: left element has no box`).not.toBeNull();
  expect(rightBox, `${label}: right element has no box`).not.toBeNull();
  const horizontal = Math.min(leftBox!.x + leftBox!.width, rightBox!.x + rightBox!.width)
    - Math.max(leftBox!.x, rightBox!.x);
  const vertical = Math.min(leftBox!.y + leftBox!.height, rightBox!.y + rightBox!.height)
    - Math.max(leftBox!.y, rightBox!.y);
  expect(horizontal > 1 && vertical > 1, `${label}: elements overlap`).toBe(false);
}

export async function readSupervisorState(): Promise<SupervisorState> {
  const stateFile = process.env.E2E_STATE_FILE;
  if (!stateFile) throw new Error("E2E_STATE_FILE is not configured");
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8")) as SupervisorState;
      if (state.initialPassword) return state;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Authentication server state was not written: ${String(lastError)}`);
}

async function json<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
  expect(response.ok(), `HTTP ${response.status()} ${response.url()}`).toBe(true);
  return response.json() as Promise<T>;
}
