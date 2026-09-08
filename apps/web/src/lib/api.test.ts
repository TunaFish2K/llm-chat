import { describe, expect, it, vi } from "vitest";
import { ApiRequestError, api, endpoints, onAuthRequired } from "./api";

function mockResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("api client", () => {
  it("parses JSON responses for GET requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.get("/api/health")).resolves.toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(init.headers).not.toHaveProperty("x-llm-chat-request");
  });

  it("sends the mutation marker header on writes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await api.post("/api/conversations", { agentId: "x" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/conversations");
    expect(init.headers).toMatchObject({ "x-llm-chat-request": "1", "content-type": "application/json" });
    expect(init.body).toBe(JSON.stringify({ agentId: "x" }));
  });

  it("maps server error payloads to ApiRequestError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse(404, { error: { code: "conversation_not_found", message: "会话不存在" } }))
    );
    const error = await api.get("/api/conversations/nope").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).code).toBe("conversation_not_found");
    expect((error as ApiRequestError).status).toBe(404);
  });

  it("emits auth-required only for authentication_required 401s", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse(401, { error: { code: "authentication_required", message: "请输入访问密码" } })
      )
    );
    const listener = vi.fn();
    const off = onAuthRequired(listener);
    await expect(api.get("/api/settings")).rejects.toMatchObject({ code: "authentication_required" });
    expect(listener).toHaveBeenCalledOnce();
    off();
  });

  it("keeps wrong-password 401s local without triggering global auth loss", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse(401, { error: { code: "password_invalid", message: "密码错误" } }))
    );
    const listener = vi.fn();
    const off = onAuthRequired(listener);
    const error = await api.post("/api/auth/login", { password: "wrong" }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).code).toBe("password_invalid");
    expect((error as ApiRequestError).message).toBe("密码错误");
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it("treats network failures as ApiRequestError with status 0", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const error = await api.get("/api/settings").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(0);
    expect((error as ApiRequestError).code).toBe("network_error");
  });

  it("handles empty, malformed, and non-Error responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 })));
    await expect(api.delete("/api/item")).resolves.toBeUndefined();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("not-json", { status: 200 })));
    await expect(api.get("/api/item")).rejects.toMatchObject({ code: "invalid_response" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockResponse(500, undefined)));
    await expect(api.get("/api/item")).rejects.toMatchObject({ code: "request_failed", status: 500 });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("offline"));
    await expect(api.get("/api/item")).rejects.toMatchObject({ code: "network_error", message: "网络请求失败" });
  });

  it("uploads a raw file with encoded metadata and maps upload errors", async () => {
    const asset = {
      id: "00000000-0000-4000-8000-000000000001",
      fileName: "报告.txt",
      mimeType: "text/plain",
      kind: "file",
      byteSize: 4,
      sha256: "a".repeat(64),
      url: `/api/files/00000000-0000-4000-8000-000000000001?v=${"a".repeat(64)}`,
      createdAt: 1
    };
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(201, asset));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["test"], "报告.txt", { type: "text/plain" });
    await expect(endpoints.uploadFile(file)).resolves.toEqual(asset);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/files");
    expect(init).toMatchObject({ method: "POST", body: file });
    expect(init.headers).toMatchObject({
      "content-type": "application/octet-stream",
      "x-llm-chat-request": "1",
      "x-file-name": encodeURIComponent("报告.txt"),
      "x-file-type": "text/plain"
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse(413, {
      error: { code: "file_too_large", message: "文件过大" }
    })));
    await expect(endpoints.uploadFile(file)).rejects.toMatchObject({
      status: 413, code: "file_too_large", message: "文件过大"
    });
  });

  it("keeps every endpoint wrapper wired to the request client", async () => {
    const fetchMock = vi.fn(async () => mockResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    const value = {} as never;
    const calls = [
      () => endpoints.login("password"),
      () => endpoints.logout(),
      () => endpoints.changePassword("password"),
      () => endpoints.bootstrap(),
      () => endpoints.bootstrap("conversation/id"),
      () => endpoints.settings(),
      () => endpoints.updateSettings(value),
      () => endpoints.agents(),
      () => endpoints.agent("agent"),
      () => endpoints.createAgent(value),
      () => endpoints.updateAgent("agent", value),
      () => endpoints.deleteAgent("agent"),
      () => endpoints.importAgent("card.json", "e30="),
      () => endpoints.setAgentAvatar("agent", "avatar.png", "eA=="),
      () => endpoints.deleteAgentAvatar("agent"),
      () => endpoints.importRoleplayPreset("agent", "preset.json", "e30="),
      () => endpoints.toolSettings(),
      () => endpoints.serviceSettings(),
      () => endpoints.searchConversations("text & title"),
      () => endpoints.updateServiceSettings(value),
      () => endpoints.queueState("conversation"),
      () => endpoints.resumeQueue("conversation"),
      () => endpoints.updateToolSettings(value),
      () => endpoints.toolCatalog(),
      () => endpoints.plugins(),
      () => endpoints.installPlugin("/plugin"),
      () => endpoints.configurePlugin("plugin", {}, {}),
      () => endpoints.reloadPlugin("plugin"),
      () => endpoints.unloadPlugin("plugin"),
      () => endpoints.removePlugin("plugin"),
      () => endpoints.skills(),
      () => endpoints.discoverSkills(),
      () => endpoints.installSkill("/skill"),
      () => endpoints.reloadSkill("skill"),
      () => endpoints.removeSkill("skill"),
      () => endpoints.memories(),
      () => endpoints.mcpServers(),
      () => endpoints.createMcpServer(value),
      () => endpoints.updateMcpServer("mcp", value),
      () => endpoints.deleteMcpServer("mcp"),
      () => endpoints.testMcpServer("mcp"),
      () => endpoints.connections(),
      () => endpoints.createConnection(value),
      () => endpoints.updateConnection("connection", value),
      () => endpoints.deleteConnection("connection"),
      () => endpoints.connectionBalance("connection"),
      () => endpoints.connectionBalance("connection", true),
      () => endpoints.testConnection("connection"),
      () => endpoints.discoverModels("connection"),
      () => endpoints.models(),
      () => endpoints.models("connection/id"),
      () => endpoints.createModel(value),
      () => endpoints.updateModel("model", value),
      () => endpoints.deleteModel("model"),
      () => endpoints.conversations(),
      () => endpoints.createConversation({ agentId: "agent" }),
      () => endpoints.startConversation({ agentId: "agent", text: "hello" }),
      () => endpoints.conversation("conversation"),
      () => endpoints.updateConversation("conversation", {}),
      () => endpoints.conversationRoleplayState("conversation"),
      () => endpoints.updateConversationRoleplayState("conversation", {}),
      () => endpoints.deleteConversation("conversation"),
      () => endpoints.forkConversation("conversation", { mode: "continue", throughMessageId: null }),
      () => endpoints.contextSummary("conversation"),
      () => endpoints.compactContext("conversation"),
      () => endpoints.messages("conversation"),
      () => endpoints.uploadImage("image.png", "aW1hZ2U="),
      () => endpoints.sendMessage("conversation", "hello"),
      () => endpoints.queuedMessages("conversation"),
      () => endpoints.enqueueMessage("conversation", "next", ["asset"]),
      () => endpoints.deleteQueuedMessage("conversation", "queued"),
      () => endpoints.deleteQueuedMessage("conversation"),
      () => endpoints.retryGeneration("message"),
      () => endpoints.selectGeneration("message", "generation"),
      () => endpoints.cancelGeneration("generation"),
      () => endpoints.generation("generation"),
      () => endpoints.resolveToolCall("tool", true),
      () => endpoints.resolveToolCall("tool", false, "reason"),
      () => endpoints.backgroundTasks(),
      () => endpoints.backgroundTasks("conversation"),
      () => endpoints.backgroundTasks(undefined, "all"),
      () => endpoints.backgroundTask("task"),
      () => endpoints.backgroundTaskOutput("task", 42),
      () => endpoints.stopBackgroundTask("task", "done"),
      () => endpoints.resizeBackgroundTask("task", 120, 40),
      () => endpoints.listDirectories(),
      () => endpoints.listDirectories("/workspace path"),
      () => endpoints.createDirectory("/workspace/new"),
      () => endpoints.validatePath("/workspace")
    ];
    await Promise.all(calls.map((call) => call()));
    expect(fetchMock).toHaveBeenCalledTimes(calls.length);
    const urls = fetchMock.mock.calls.map((args) => (args as unknown as [string])[0]);
    expect(urls).toContain("/api/bootstrap?conversationId=conversation%2Fid");
    expect(urls).toContain("/api/background-tasks?scope=all");
    expect(urls).toContain("/api/filesystem/directories?path=%2Fworkspace%20path");
    expect(urls.filter((url) => url === "/api/conversations/conversation/context/compact")).toHaveLength(2);
  });
});
