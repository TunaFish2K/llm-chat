import { describe, expect, it, vi } from "vitest";
import {
  createPluginRegistry,
  describePluginTools,
  handlePluginLine,
  serializeHostMessage,
  type ToolSpec
} from "./plugin-host-runtime";

function tool(overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    name: "echo",
    description: "Echo input",
    inputSchema: { type: "object" },
    execute: (input, context) => ({ input, context }),
    ...overrides
  };
}

describe("plugin host runtime", () => {
  it("creates a frozen API, validates registrations, and rejects duplicates", () => {
    const { api, tools } = createPluginRegistry({ endpoint: "local", token: "old" }, { token: "secret" });

    expect(api.config).toEqual({ endpoint: "local", token: "secret" });
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.config)).toBe(true);
    api.registerTool(tool());
    expect(tools.get("echo")?.description).toBe("Echo input");
    expect(() => api.registerTool(tool())).toThrow("Duplicate tool name: echo");
    expect(() => api.registerTool(null as unknown as ToolSpec)).toThrow("Invalid tool registration");
    expect(() => api.registerTool(tool({ name: "bad name" }))).toThrow("Invalid tool registration");
    expect(() => api.registerTool(tool({ execute: null as unknown as ToolSpec["execute"] }))).toThrow("Invalid tool registration");
  });

  it("describes default and explicit tool metadata and approval modes", () => {
    const { api, tools } = createPluginRegistry({}, {});
    api.registerTool(tool());
    api.registerTool(tool({ name: "always", label: "Always", category: "system", requiresApproval: true }));
    api.registerTool(tool({ name: "dynamic", requiresApproval: async () => true }));

    expect(describePluginTools(tools)).toEqual([
      { name: "echo", label: "echo", description: "Echo input", category: "plugin", inputSchema: { type: "object" }, approvalMode: "never" },
      { name: "always", label: "Always", description: "Echo input", category: "system", inputSchema: { type: "object" }, approvalMode: "always" },
      { name: "dynamic", label: "dynamic", description: "Echo input", category: "plugin", inputSchema: { type: "object" }, approvalMode: "dynamic" }
    ]);
  });

  it("ignores malformed messages and handles pings and lookup failures", async () => {
    const { tools } = createPluginRegistry({}, {});

    await expect(handlePluginLine(tools, "{")).resolves.toBeUndefined();
    await expect(handlePluginLine(tools, "null")).resolves.toBeUndefined();
    await expect(handlePluginLine(tools, "[]")).resolves.toBeUndefined();
    await expect(handlePluginLine(tools, "{}" )).resolves.toBeUndefined();
    await expect(handlePluginLine(tools, JSON.stringify({ id: "1", type: "ping" }))).resolves.toEqual({ id: "1", ok: true, result: "pong" });
    await expect(handlePluginLine(tools, JSON.stringify({ id: "2", type: "execute", tool: "missing" }))).resolves.toEqual({
      id: "2", ok: false, error: "Plugin tool not found"
    });
  });

  it("evaluates fixed and dynamic approvals", async () => {
    const approval = vi.fn(async (input: Record<string, unknown>) => input.allow === true);
    const { api, tools } = createPluginRegistry({}, {});
    api.registerTool(tool({ name: "fixed", requiresApproval: true }));
    api.registerTool(tool({ name: "dynamic", requiresApproval: approval }));

    await expect(handlePluginLine(tools, JSON.stringify({ id: "1", type: "approval", tool: "fixed" }))).resolves.toEqual({ id: "1", ok: true, result: true });
    await expect(handlePluginLine(tools, JSON.stringify({ id: "2", type: "approval", tool: "dynamic", input: { allow: false } }))).resolves.toEqual({ id: "2", ok: true, result: false });
    expect(approval).toHaveBeenCalledWith({ allow: false });
  });

  it("executes tools, serializes results, and reports thrown failures", async () => {
    const { api, tools } = createPluginRegistry({}, {});
    api.registerTool(tool());
    api.registerTool(tool({ name: "text", execute: () => "raw" }));
    api.registerTool(tool({ name: "empty", execute: () => null }));
    api.registerTool(tool({ name: "failure", execute: (input) => {
      if (input.value === "string") throw "plain failure";
      throw new Error("tool failure");
    } }));

    await expect(handlePluginLine(tools, JSON.stringify({ id: "1", type: "execute", tool: "echo", input: { value: 1 }, context: { workspace: "/tmp" } }))).resolves.toEqual({
      id: "1", ok: true, result: JSON.stringify({ input: { value: 1 }, context: { workspace: "/tmp" } })
    });
    await expect(handlePluginLine(tools, JSON.stringify({ id: "2", type: "execute", tool: "text" }))).resolves.toEqual({ id: "2", ok: true, result: "raw" });
    await expect(handlePluginLine(tools, JSON.stringify({ id: "3", type: "execute", tool: "empty" }))).resolves.toEqual({ id: "3", ok: true, result: "{}" });
    await expect(handlePluginLine(tools, JSON.stringify({ id: "4", type: "execute", tool: "failure" }))).resolves.toEqual({ id: "4", ok: false, error: "tool failure" });
    await expect(handlePluginLine(tools, JSON.stringify({ id: "5", type: "execute", tool: "failure", input: { value: "string" } }))).resolves.toEqual({ id: "5", ok: false, error: "plain failure" });
    await expect(handlePluginLine(tools, JSON.stringify({ id: "6", type: "other", tool: "echo" }))).resolves.toEqual({ id: "6", ok: false, error: "Unknown plugin host request" });
  });

  it("serializes newline-delimited messages and rejects oversized responses", () => {
    expect(serializeHostMessage({ ok: true })).toBe('{"ok":true}\n');
    expect(() => serializeHostMessage("x".repeat(4 * 1024 * 1024 + 1))).toThrow("Plugin host response is too large");
  });
});

it("exposes optional independent Markdown formatters without changing execute results", async () => {
  const { api, tools } = createPluginRegistry({}, {});
  api.registerTool(tool({
    formatArguments: (input) => ({ summary: String(input.value), detail: "**args**" }),
    formatResult: ({ output }) => ({ detail: `Output: ${output}` })
  }));
  expect(describePluginTools(tools)[0]).toMatchObject({ formatArguments: true, formatResult: true });
  const call = (type: string) => handlePluginLine(tools, JSON.stringify({ id: "1", type, tool: "echo", input: { value: "hello" }, output: "raw" }));
  await expect(call("format-arguments")).resolves.toMatchObject({ ok: true, result: { summary: "hello", detail: "**args**" } });
  await expect(call("format-result")).resolves.toMatchObject({ ok: true, result: { detail: "Output: raw" } });
  await expect(call("execute")).resolves.toMatchObject({ ok: true, result: '{"input":{"value":"hello"},"context":{}}' });
});
