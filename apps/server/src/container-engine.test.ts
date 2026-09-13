import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalContainerEngine } from "./container-engine";

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("DOCKER_HOST", ""); vi.stubEnv("DOCKER_CONTEXT", ""); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
function child() {
  return { kill: vi.fn(), stdin: Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() }),
    stdout: { destroy: vi.fn() }, stderr: { destroy: vi.fn() } };
}
function responses() {
  mocks.execFile.mockImplementation((_executable, args, _options, callback) => {
    queueMicrotask(() => callback(null, args.includes("context") ? JSON.stringify([{ Endpoints: { docker: { Host: "unix:///test/docker.sock" } } }]) : "ready\n", ""));
    return child();
  });
}

it("rejects remote Docker endpoints without issuing a container command", async () => {
  vi.stubEnv("DOCKER_HOST", "tcp://remote:2375");
  const engine = new LocalContainerEngine("docker");
  expect(await engine.probe()).toMatchObject({ available: false, error: "Remote Docker engines are not supported" });
  expect(mocks.execFile).not.toHaveBeenCalled();
});

it("pins the selected local Docker context for execution and forwards stdin separately", async () => {
  responses();
  vi.stubEnv("DOCKER_CONTEXT", "local");
  vi.stubEnv("DOCKER_HOST", "tcp://ignored:2375");
  const engine = new LocalContainerEngine("docker");
  expect(await engine.probe()).toMatchObject({ available: true });
  expect(mocks.execFile.mock.calls[0]![1]).toEqual(["context", "inspect", "local"]);
  expect(engine.command(["exec", "name", "node"])).toEqual({ executable: "docker", args: ["--host", "unix:///test/docker.sock", "exec", "name", "node"] });
  await engine.run(["exec", "-i", "name", "cat"], "literal $(data)");
  expect(mocks.execFile.mock.results.at(-1)!.value.stdin.end).toHaveBeenCalledWith("literal $(data)");
});

it("forces Podman to run locally", async () => {
  responses();
  expect(await new LocalContainerEngine("podman").probe()).toMatchObject({ available: true });
  expect(mocks.execFile.mock.calls.every(call => call[0] === "podman" && call[1][0] === "--remote=false")).toBe(true);
});

it("bounds engine calls when an inherited pipe prevents the CLI callback", async () => {
  vi.useFakeTimers();
  const transport = child();
  mocks.execFile.mockReturnValue(transport);
  const operation = new LocalContainerEngine("podman").run(["start", "name"], undefined, 1000);
  const failure = expect(operation).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(1100);
  await failure;
  expect(transport.kill).toHaveBeenCalledWith("SIGKILL");
  expect(transport.stdout.destroy).toHaveBeenCalled();
});
