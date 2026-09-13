import { execFile } from "node:child_process";
import type { ContainerEngine, ContainerEngineDto } from "@llm-chat/contracts";

export interface EngineCommand { executable: string; args: string[]; }
export interface EngineAdapter {
  engine: ContainerEngine;
  command(args: string[]): EngineCommand;
  run(args: string[], input?: string, timeout?: number): Promise<string>;
  probe(): Promise<ContainerEngineDto>;
}

/** Engine control runs only on the application host. It never accepts shell text. */
export class LocalContainerEngine implements EngineAdapter {
  private endpoint: string | undefined;
  constructor(readonly engine: ContainerEngine) {}
  command(args: string[]): EngineCommand {
    return { executable: this.engine, args: [...(this.engine === "podman" ? ["--remote=false"] : this.endpoint ? ["--host", this.endpoint] : []), ...args] };
  }
  async run(args: string[], input?: string, timeout = 10_000): Promise<string> {
    await this.localEndpoint();
    return this.raw(args, input, timeout);
  }
  private async localEndpoint(): Promise<void> {
    if (this.engine !== "docker" || this.endpoint) return;
    const selected = process.env.DOCKER_CONTEXT;
    const host = !selected && process.env.DOCKER_HOST ? process.env.DOCKER_HOST
      : JSON.parse(await this.raw(["context", "inspect", ...(selected ? [selected] : [])], undefined, 5000))[0]?.Endpoints?.docker?.Host;
    if (typeof host !== "string" || !host.startsWith("unix://")) throw new Error("Remote Docker engines are not supported");
    this.endpoint = host;
  }
  private raw(args: string[], input: string | undefined, timeout: number): Promise<string> {
    const command = this.command(args);
    return new Promise((resolve, reject) => {
      const child = execFile(command.executable, command.args, { timeout, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
        clearTimeout(deadline);
        if (error) reject(new Error(`${this.engine}: ${stderr.trim() || error.message}`));
        else resolve(stdout.trim());
      });
      // Engine helpers can inherit the CLI pipes. Bound the request even when
      // those helpers keep stdout open after the CLI has exited.
      const deadline = setTimeout(() => {
        child.kill("SIGKILL");
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
        reject(new Error(`${this.engine}: operation timed out after ${timeout} ms`));
      }, timeout + 100);
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  }
  async probe(): Promise<ContainerEngineDto> {
    try {
      if (process.platform !== "linux") throw new Error("Container environments require a local Linux host");
      const version = await this.run(["--version"], undefined, 5000);
      await this.run(["info"], undefined, 5000);
      return { engine: this.engine, available: true, version, error: null };
    } catch (error) {
      return { engine: this.engine, available: false, version: null, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
