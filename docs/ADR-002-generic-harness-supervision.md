# ADR-002: Generic Harness Supervision

## Status

Accepted

## Decision

The application uses the Codex app-server adapter when Codex is available. An Agent can start a new Codex thread, attach an existing app-server thread, send turns, inspect structured events, answer protocol requests, and interrupt the active turn through `codex_*` tools. When Codex is unavailable, the Agent starts another CLI harness through generic background tools in pipe or PTY mode and supervises it through `background_wait`, `background_read`, `background_write`, and `background_stop`. OpenCode adapters remain deferred.

The supervising generation repeatedly observes output and decides whether to answer an interactive approval prompt. Cancelling the generation only detaches the supervisor. It does not stop the background task. The user stops a task explicitly from the task drawer or through an approved tool call.

The bundled `coding-supervisor` Skill prefers Codex app-server tools and falls back to generic harness supervision. Codex uses a trusted-local YOLO profile only when the server is explicitly configured for it; the default server-workspace profile keeps Codex approval and workspace restrictions active. The user can observe the bound thread in the task view, answer pending approvals, send a takeover turn, or interrupt it.

## Consequences

- The chat application stays focused on orchestration instead of reproducing coding harness features.
- Codex work has structured lifecycle and approval events instead of terminal scraping.
- New CLI harnesses still work without a provider adapter when they can run in a terminal.
- OpenCode and other provider-specific adapters can be added behind the same boundary later.
