import type { DatabaseSync } from "node:sqlite";
import { processStartIdentity } from "../background-tasks";
import { repairTerminalToolCalls } from "../database-repair";

/** Run once after migrations and before managers resume persisted work. */
export function recoverInterruptedWork(sqlite: DatabaseSync): void {
  const interruptedAt = Date.now();
  sqlite
    .prepare("UPDATE generations SET status = 'interrupted', completed_at = ? WHERE status IN ('queued', 'running')")
    .run(interruptedAt);
  repairTerminalToolCalls(sqlite, interruptedAt, "Generation interrupted before tool execution completed");
  for (const task of sqlite.prepare("SELECT pid, process_group_id, process_start_identity FROM background_tasks WHERE status IN ('starting','running')").all()) {
    const pid = task.pid === null ? null : Number(task.pid);
    const expected = task.process_start_identity == null ? null : String(task.process_start_identity);
    if (!pid || !expected || processStartIdentity(pid) !== expected) continue;
    try { process.kill(-Number(task.process_group_id ?? pid), "SIGKILL"); } catch {}
  }
  sqlite.prepare(`
    UPDATE background_tasks SET status = 'interrupted', error = '服务重启，后台进程未恢复', completed_at = ?
    WHERE status IN ('queued', 'starting', 'running')
  `).run(Date.now());
}
