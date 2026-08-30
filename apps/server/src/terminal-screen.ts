import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export async function terminalScreen(raw: string, columns = 120, rows = 40): Promise<string> {
  try {
    const module = require("@xterm/headless") as { Terminal: new (options: { cols: number; rows: number; allowProposedApi: boolean }) => {
      buffer: { active: { viewportY: number; getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined } };
      write(data: string, callback: () => void): void;
      dispose(): void;
    } };
    const terminal = new module.Terminal({ cols: columns, rows, allowProposedApi: false });
    await new Promise<void>((resolve) => terminal.write(raw, resolve));
    const lines: string[] = [];
    const start = terminal.buffer.active.viewportY;
    for (let index = start; index < start + rows; index += 1) {
      lines.push(terminal.buffer.active.getLine(index)?.translateToString(true) ?? "");
    }
    terminal.dispose();
    return lines.join("\n").replace(/\n+$/g, "");
  } catch {
    return raw.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").slice(-32 * 1024);
  }
}
