import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const TERMINAL_TOOL_FAILURE = "Generation ended before tool execution completed";

export function repairTerminalToolCalls(
  sqlite: DatabaseSyncType,
  completedAt: number,
  failure = TERMINAL_TOOL_FAILURE,
  denial = "Tool execution denied because generation ended",
  generationId?: string
): void {
  sqlite.prepare(`
    UPDATE generation_tool_calls
    SET approval_state = CASE
          WHEN approval_state IN ('pending', 'denied') THEN 'denied'
          ELSE 'failed'
        END,
        output = CASE
          WHEN approval_state IN ('pending', 'denied') THEN json_object('error', ?)
          ELSE json_object('error', ?)
        END,
        error = CASE
          WHEN approval_state IN ('pending', 'denied') THEN NULL
          ELSE ?
        END,
        completed_at = COALESCE(completed_at, ?)
    WHERE output IS NULL AND error IS NULL
      AND generation_id IN (
        SELECT id FROM generations WHERE status IN ('completed', 'failed', 'stopped', 'interrupted')
      )
      AND (? IS NULL OR generation_id = ?)
  `).run(denial, failure, failure, completedAt, generationId ?? null, generationId ?? null);
}

