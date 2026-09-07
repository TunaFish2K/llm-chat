import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexManager } from "./codex";
import { EventHub } from "./events";
import { cleanupStores, createStore } from "./test-helpers";

const dirs: string[] = [];

afterEach(() => {
  cleanupStores();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CodexManager", () => {
  it("uses the stdio fallback and persists a supervised thread lifecycle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-chat-codex-test-"));
    dirs.push(dir);
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    const binary = join(dir, "fake-codex.mjs");
    writeFileSync(binary, `#!/usr/bin/env node
import readline from "node:readline";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  console.log("fake-codex 1.0");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "daemon") process.exit(1);

const thread = (id, cwd) => ({
  id, sessionId: "session-1", forkedFromId: null, parentThreadId: null,
  preview: "Fake coding thread", ephemeral: false, section: null,
  sectionEnteredAt: null, projectId: null, historyMode: "normal",
  modelProvider: "openai", model: "fake-model", reasoningEffort: null,
  createdAt: 1, updatedAt: 2, recencyAt: 2, status: { type: "idle" },
  path: null, cwd, cliVersion: "fake", source: { kind: "appServer" },
  threadSource: { kind: "appServer" }, agentNickname: null, agentRole: null,
  gitInfo: null, name: "Fake thread", turns: []
});

const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const params = message.params ?? {};
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: { data: [thread("thread-existing", params.cwd ?? "/tmp")], nextCursor: null, backwardsCursor: null } });
  } else if (message.method === "thread/start" || message.method === "thread/resume") {
    const id = params.threadId ?? "thread-new";
    send({ id: message.id, result: { thread: thread(id, params.cwd), model: "fake-model", modelProvider: "openai" } });
  } else if (message.method === "turn/start" || message.method === "turn/steer") {
    send({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
  }
});
`);
    chmodSync(binary, 0o755);

    const store = createStore();
    const conversation = store.createConversation({ systemPrompt: "", workspacePath: workspace });
    const manager = new CodexManager(store, new EventHub(), {
      binary,
      socketPath: join(dir, "unused.sock"),
      profile: "server-workspace"
    });
    try {
      await expect(manager.status()).resolves.toMatchObject({ available: true, connected: true, version: "fake-codex 1.0" });
      await expect(manager.listThreads(workspace)).resolves.toEqual([
        expect.objectContaining({ id: "thread-existing", cwd: workspace })
      ]);

      const session = await manager.create({ conversationId: conversation.id, profile: "trusted-local-yolo" });
      expect(session).toMatchObject({
        threadId: "thread-new",
        cwd: workspace,
        profile: "server-workspace",
        status: "idle",
        lastEventId: expect.any(Number)
      });

      const running = await manager.send(session.id, { text: "Inspect the repository" });
      expect(running).toMatchObject({ status: "running", currentTurnId: "turn-1" });
      expect(manager.detail(session.id, 0).events.map((event) => event.method)).toEqual([
        "thread/start", "turn/start"
      ]);

      const stopped = await manager.interrupt(session.id);
      expect(stopped).toMatchObject({ status: "stopped", currentTurnId: null });
      expect(manager.detail(session.id, 0).session.lastEventId).toBeGreaterThan(2);
    } finally {
      await manager.close();
    }
  });
});
