import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

export function TaskTerminal({ raw }: { raw: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const instance = new Terminal({ disableStdin: true, convertEol: true, scrollback: 1_000_000, fontSize: 12 });
    terminal.current = instance;
    instance.open(ref.current);
    return () => { instance.dispose(); terminal.current = null; };
  }, []);
  useEffect(() => {
    const instance = terminal.current;
    if (!instance) return;
    instance.reset();
    instance.write(raw);
  }, [raw]);
  return <div ref={ref} className="task-terminal" aria-label="只读终端输出" />;
}
