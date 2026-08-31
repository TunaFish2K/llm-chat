import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskTerminal } from "./TaskTerminal";

const xterm = vi.hoisted(() => ({
  instances: [] as Array<{
    options: Record<string, unknown>;
    open: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    open = vi.fn();
    reset = vi.fn();
    write = vi.fn();
    dispose = vi.fn();

    constructor(readonly options: Record<string, unknown>) {
      xterm.instances.push(this);
    }
  }
}));

describe("TaskTerminal", () => {
  it("opens a read-only terminal, replaces output, and disposes it", () => {
    const { rerender, unmount } = render(<TaskTerminal raw={"first\n"} />);
    const instance = xterm.instances[0]!;

    expect(screen.getByLabelText("只读终端输出")).toBeInTheDocument();
    expect(instance.options).toMatchObject({ disableStdin: true, convertEol: true, scrollback: 1_000_000, fontSize: 12 });
    expect(instance.open).toHaveBeenCalledOnce();
    expect(instance.reset).toHaveBeenCalledOnce();
    expect(instance.write).toHaveBeenLastCalledWith("first\n");

    rerender(<TaskTerminal raw="complete output" />);
    expect(instance.reset).toHaveBeenCalledTimes(2);
    expect(instance.write).toHaveBeenLastCalledWith("complete output");

    unmount();
    expect(instance.dispose).toHaveBeenCalledOnce();
  });
});
