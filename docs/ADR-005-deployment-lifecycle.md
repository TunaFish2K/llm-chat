# ADR-005: Deployment Lifecycle

## Status

Accepted

## Context

llm-chat is a single-process application backed by one SQLite database and a set of files that are part of the
same persisted state. It can run active model generations, supervised background processes, isolated Plugin hosts,
and MCP connections. It must therefore expose a lifecycle contract that an external process manager can operate
without guessing which state is safe to share or replace.

## Decisions

### One process per data directory

The server acquires an instance lock for the canonical `LLM_CHAT_DATA_DIR` before constructing `Store`. The lock
uses `.llm-chat-instance` and canonicalization prevents path aliases, including symlinks, from bypassing it. A
second server using the directory fails. The offline authentication reset CLI uses the same lock.

There is one replica per data directory. An update or restart must stop the old process and wait for its exit before
starting the next process; a different port does not make overlapping access safe.

### Immutable code and the Web artifact

Production serves the built Web artifact by default (`LLM_CHAT_SERVE_WEB=true`). Startup requires
`apps/web/dist/index.html` in that code release. An API-only process may explicitly set `LLM_CHAT_SERVE_WEB=false`;
that mode does not register the Web static-file handler and does not require the Web artifact. Code releases are
immutable after build. The `LLM_CHAT_DATA_DIR` remains a separate writable directory containing SQLite and managed
runtime state.

### Liveness and readiness are distinct

`/healthz` reports liveness after the listener is available and returns `200` with `ok: true` and `buildId`; it does
not query SQLite. `/readyz` reports whether the process may receive traffic. It returns `200` only after startup has
set readiness, SQLite passes `SELECT 1`, and, when Web serving is enabled, the Web entry still exists. It returns
`503` while startup is incomplete, a check fails, or shutdown is draining. Both responses include `buildId` so a
manager and operator can identify the running release.

Readiness is withdrawn before draining begins. A manager routes traffic using `/readyz` and may use `/healthz` only
to decide whether the process is alive and should be restarted.

### Bounded shutdown and drain

On `SIGTERM` or `SIGINT`, the server marks itself closing and withdraws readiness. The generation runner aborts all
active generation jobs and waits for their job promises. Fastify close then closes background tasks, registries,
Plugin/MCP resources, and the Store before releasing the instance lock.

Background tasks are marked `interrupted` during service shutdown. A live task receives `SIGTERM` for its process
group and gets up to two seconds to exit; the manager then sends `SIGKILL` and waits for the exit. Queued and
remaining non-terminal tasks are also marked interrupted. The application-level `LLM_CHAT_SHUTDOWN_TIMEOUT_MS`
is bounded to 1000-300000 ms, defaults to 30000 ms, and forces process exit if the complete shutdown exceeds it.
The external manager's grace period must be longer than this application timeout.

### Offline-only authentication reset

Password recovery is an offline CLI operation, not an HTTP operation. It requires exactly
`--confirm-reset-password`, acquires the data-directory lock, creates a new eight-digit password, and revokes active
sessions in one transaction. It preserves chat and application data. The service must be stopped while it runs. The
CLI prints the replacement password.

### Whole-directory backup

The backup and restore unit is the complete `LLM_CHAT_DATA_DIR`, not only the SQLite file. SQLite sidecars,
content-addressed Plugin and Skill revisions, background task logs, persisted large tool outputs, workspace files,
and other runtime state can be required to interpret or recover the database. The directory also contains API keys,
secret headers, password hashes, session material, and Plugin secrets, so it is treated as secret material. The simple
supported backup and restore procedure requires a stopped service and restores the directory as a whole without
merging it with a live or partially retained directory.

### Build identity

`LLM_CHAT_BUILD_ID` is a validated single-line identifier (1-200 characters) with default `development`. The server
includes it in `/healthz`, `/readyz`, and lifecycle logs. Operators set a stable release identifier so probes and
logs distinguish code versions during rollout and rollback.

### External manager and proxy boundary

The repository defines the process and HTTP lifecycle contract only. The user's external `served` manager owns
process supervision, replica count, restart ordering, and grace periods. An optional reverse proxy owns TLS and
the public network boundary. This repository deliberately does not generate or prescribe `served`, container,
systemd, or nginx configuration.

## Consequences

- Horizontal replicas cannot share one data directory; scaling requires an independent data and ownership design.
- A graceful restart first removes a process from traffic, then drains generations and tasks, reducing concurrent
  writes before SQLite closes.
- A task that ignores `SIGTERM` is forcibly terminated after two seconds, and the application has a bounded final
  shutdown deadline. Operators must choose a manager grace period longer than that deadline.
- API-only deployments can omit the Web artifact, but they cannot provide the bundled Web UI from that process.
- Build IDs make mixed-release observations visible in probes and logs, while immutable releases make update and
  rollback selection explicit.
- Whole-directory backups are larger and contain secrets, but SQLite-only backups cannot restore managed revisions,
  task logs, or persisted tool outputs.
- Authentication recovery requires host-level access to the stopped service's data directory. It cannot be performed
  through the application HTTP API.
- Process-manager, container, TLS, and reverse-proxy policy remains an operator responsibility outside this
  repository.
