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

The server reads its JSON configuration and acquires an instance lock for the canonical `dataDir` before
constructing `Store`. The lock uses `.llm-chat-instance` and canonicalization prevents path aliases, including symlinks, from bypassing it. A
second server using the directory fails. The offline authentication reset CLI uses the same lock.

There is one replica per data directory. An update or restart must stop the old process and wait for its exit before
starting the next process; a different port does not make overlapping access safe.

### Explicit startup recovery

Opening a Store performs database initialization and schema migrations. Application startup then explicitly runs
persisted-work recovery before image jobs, background managers, or the message queue can resume work. Recovery
interrupts unfinished foreground generations, completes their missing tool results, and interrupts stale background
tasks. A stored process is terminated only when its recorded start identity matches the live process. Waiting
approvals remain resumable, and image jobs retain their own manager's recovery behavior.

Opening a Store for maintenance, including the offline password reset command, does not run task recovery.
Maintenance commands still acquire the data-directory lock and require the server to be stopped.

### Immutable code and the Web artifact

The server always serves the built Web artifact. Startup requires `apps/web/dist/index.html` in the release;
readiness always checks that file. There is no API-only mode. Releases are immutable after build, while the
configured `dataDir` remains a separate writable directory. Development builds the Web artifact before starting
its watchers. Tests supply a temporary Web root as a file dependency, without a production serving bypass.

### Plain JSON runtime configuration

The server reads runtime settings from `config.json` in the project root or from the path selected with
`--config <path>`. It does not read the retired `LLM_CHAT_*` runtime environment variables. A normal server start
atomically creates a missing file with complete safe defaults and owner-only permissions; it never overwrites an
existing invalid file. Maintenance commands require an existing configuration so they cannot silently select a new
default data directory. Relative `dataDir` values resolve from the configuration file's directory.

Runtime configuration contains only `host`, `port`, and `dataDir`. Password authentication is always enabled.
Proxy headers do not override the direct connection protocol or client IP. Existing configurations must remove
`authMode`, `trustProxy`, `serveWeb`, `shutdownTimeoutMs`, and `buildId`; the parser reports retired fields instead
of silently accepting them. Passwords and sessions are preserved.

The file is plain JSON and receives no application-level encryption. It currently contains process settings rather
than model credentials. Operators protect and back it up separately from the runtime data directory.

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
remaining non-terminal tasks are also marked interrupted. The application-level deadline is fixed at 30 seconds
and forces exit with code 1 if cleanup exceeds it.
The external manager's grace period must be longer than this application timeout.

### Offline-only authentication reset

Password recovery is an offline CLI operation, not an HTTP operation. It requires `--confirm-reset-password`,
accepts the shared `--config <path>` selector, acquires the data-directory lock, creates a new eight-digit password,
and revokes active sessions in one transaction. It preserves chat and application data. The service must be stopped
while it runs. The CLI prints the replacement password.

### Whole-directory backup

The runtime backup and restore unit is the complete configured `dataDir`, not only the SQLite file. SQLite sidecars,
content-addressed Plugin and Skill revisions, background task logs, persisted large tool outputs, workspace files,
and other runtime state can be required to interpret or recover the database. The directory also contains API keys,
secret headers, password hashes, session material, and Plugin secrets, so it is treated as secret material. The simple
supported backup and restore procedure requires a stopped service and restores the directory as a whole without
merging it with a live or partially retained directory.

### Build identity

The build embeds `buildId` in the server and writes the same value to `dist/build-info.json` for deployment checks.
It uses the first 12 Git commit characters, appending `-dirty-<content hash>` for changed build inputs. Git archives
carry the revision through an export-substituted `BUILD_REVISION`. Sources without Git or archive metadata use a
`source-<content hash>` identifier. Source development uses `development`. Runtime configuration and environment
variables cannot change a compiled release's identity. Probes and lifecycle logs retain the `buildId` field.

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
- Every deployment includes the Web artifact and requires password authentication.
- Runtime configuration has one explicit JSON source and can bootstrap itself on first server start; operators must
  manage and back up an external configuration file separately.
- Build IDs make mixed-release observations visible in probes and logs, while immutable releases make update and
  rollback selection explicit.
- Whole-directory backups are larger and contain secrets, but SQLite-only backups cannot restore managed revisions,
  task logs, or persisted tool outputs.
- Authentication recovery requires host-level access to the stopped service's data directory. It cannot be performed
  through the application HTTP API.
- Process-manager, container, TLS, and reverse-proxy policy remains an operator responsibility outside this
  repository.
