# ADR-002: Generic Harness Supervision

## Status

Accepted

## Decision

The application does not implement provider-specific Codex or OpenCode adapters. An Agent starts any CLI harness through generic background tools in pipe or PTY mode and supervises it through `background_wait`, `background_read`, `background_write`, and `background_stop`.

The supervising generation repeatedly observes output and decides whether to answer an interactive approval prompt. Cancelling the generation only detaches the supervisor. It does not stop the background task. The user stops a task explicitly from the task drawer or through an approved tool call.

The bundled `coding-supervisor` Skill recommends approval for task creation and automatic access to monitoring and terminal response tools. It instructs the Agent to inspect a harness command's own help instead of assuming provider-specific flags.

## Consequences

- The chat application stays focused on orchestration instead of reproducing coding harness features.
- New CLI harnesses work without a server release when they can run in a terminal.
- The Agent, not a hard-coded adapter, interprets harness prompts and progress.
