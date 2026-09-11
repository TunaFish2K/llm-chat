# Integrated Normal-Use QA Findings and Resolutions

- Tested SHA: `acd7f5b798d6b0b548ece50ee6067044a1662ad8`
- Test date: 2026-08-31 (Asia/Shanghai)
- Fix verification: 2026-08-31, current worktree before the resolution commit
- Environment: Debian GNU/Linux, Linux `6.12.105+deb13-amd64`, x86_64, Node.js `v24.20.0`, pnpm `11.7.0`
- Scope: the integrated local, single-user product; compiled server and web client; API and static serving; existing node and jsdom suites; isolated runtime data under `/tmp`

## Executive Summary

All six recorded findings are resolved. MCP partial updates preserve omitted values. The web build now uses bounded lazy chunks. The quality gate passes its configured coverage thresholds, and the DOM test suite has an enforced 60-second total and 30-second per-file budget. Ant Design deprecations and shared jsdom capability gaps are removed from normal test output.

The final coverage verification passes 312 assertions across 33 files. Global coverage is 92.95% statements/lines, 91.97% functions, and 85.35% branches. The DOM suite passes 100 assertions in 56.64 seconds; 22 DOM-free web assertions run in the faster Node project.

| Result class | Count | Summary |
| --- | ---: | --- |
| Resolved product findings | 2 | MCP partial-update data loss; oversized production JavaScript chunks |
| Resolved harness findings | 4 | Coverage gate, long web tests, Ant Design deprecations, shared browser test stubs |
| Passing coverage assertions | 312 | 33 test files; all configured global and critical-file thresholds pass |
| Performance-gated DOM assertions | 100 | 56.64 seconds total; no file exceeds 30 seconds |

## Confirmed Findings

### QA-001: Partial MCP updates erase headers and can re-enable the server

- Severity: High
- Status: resolved
- Affected workflow: Settings > Extensions > MCP; any caller of `PATCH /api/mcp/servers/:id`
- Exact reproduction:
  1. Start the production build with a fresh `LLM_CHAT_DATA_DIR`.
  2. `POST /api/mcp/servers` with `{"name":"QAMCP1","url":"https://example.invalid/mcp","headers":{"Authorization":"qa-placeholder"},"enabled":false}`.
  3. Confirm the response contains `"headerNames":["Authorization"]` and `"enabled":false`.
  4. `PATCH /api/mcp/servers/:id` with only `{"name":"QAMCP2"}`.
  5. Read the response or call `GET /api/mcp/servers`.
- Expected: omitted `headers` and `enabled` fields remain unchanged. The response should still report `headerNames: ["Authorization"]` and `enabled: false`.
- Actual: the PATCH response and subsequent list report `headerNames: []` and `enabled: true`.
- Evidence: the production smoke returned HTTP 201 for creation, HTTP 200 for the partial update, then persisted `{"name":"QAMCP2","headerNames":[],"enabled":true}`. The existing server API test updates an MCP server with `{ enabled: false }`, but asserts only the enabled field and therefore does not detect header loss.
- Impact: toggling an MCP server from the UI sends a partial update. That action can silently delete configured authorization headers, making the server unusable. Other partial API updates can also enable a server against the user's intent.
- Suggested follow-up: introduce a PATCH-specific schema with no defaults, preserve every omitted field in storage, and add API regression tests for header and enabled-state preservation on name-only and enabled-only updates.
- Resolution: `mcpServerPatchSchema` no longer applies create-time defaults. The PATCH route uses this schema, and regressions cover name-only updates, enabled-only updates, and explicit header clearing.

### QA-003: The repository quality gate fails after all assertions pass

- Severity: Medium
- Status: resolved
- Affected workflow: local `pnpm check` and CI/release gating
- Exact reproduction: run `pnpm check` from a clean integrated checkout with dependencies installed.
- Expected: after type checking and 281 passing tests, configured coverage meets the gate and the command proceeds to `pnpm build`.
- Actual: 23/23 test files and 281/281 assertions pass, but coverage exits 1. The build chained after coverage is not run.
- Evidence:
  - Global statements and lines: 89.75%, below 90%.
  - Global functions: 83.43%, below 90%.
  - Global branches: 82.92%, below 85%.
  - `apps/web/src/api.ts` functions: 69.23%, below its 90% file threshold.
  - The earlier baseline expectation referenced 273 passing assertions; the integrated SHA now has 281, but the gate still fails.
- Impact: the canonical all-in-one check is red even when behavior tests pass. This obscures real regressions and prevents the final build stage from running in that command.
- Suggested follow-up: add focused coverage for uncalled API helpers and globally weak modules, or deliberately revise thresholds/exclusions if the current target is not the intended policy. Keep a separate build job so coverage failure does not hide build status.
- Resolution: focused API, extension-host, workspace, Skill, EventHub, character-card, App workflow, and settings workflow tests raise coverage above every existing threshold without lowering the policy. Latest global coverage is 92.95% statements/lines, 91.97% functions, and 85.35% branches.

### QA-002: Production web build emits two oversized JavaScript entry chunks

- Severity: Low
- Status: resolved
- Affected workflow: first load and cache refresh of the local web client
- Exact reproduction: run `pnpm build` and inspect the Vite size report.
- Expected: production chunks remain below the configured 500 kB warning threshold, or the project explicitly documents and budgets larger entry payloads.
- Actual: Vite warns about chunks larger than 500 kB. The two entry chunks are 1,591.45 kB (524.55 kB gzip) and 1,980.08 kB (599.66 kB gzip), excluding source maps.
- Evidence: the build transformed 7,982 modules and printed the standard Vite large-chunk warning. The generated `apps/web/dist` directory was approximately 17 MiB including maps and assets.
- Impact: this is a performance risk rather than a demonstrated functional failure. It can increase parse/startup time and makes cold loads heavier, especially on constrained machines.
- Suggested follow-up: measure browser startup before setting a performance budget, then consider route/component-level dynamic imports or deliberate Rollup chunking.
- Resolution: Markdown languages, settings, and terminal UI load on demand. Rollup separates React, Ant Design, Ant Design X, rc, terminal, and Markdown dependencies. The largest emitted JavaScript chunk is 424.73 kB, below the 500 kB warning threshold.

### QA-004: Web tests have excessive duration and poor feedback time

- Severity: Low
- Status: resolved
- Affected workflow: local frontend development and CI feedback
- Exact reproduction: run `pnpm exec vitest run --project web --reporter=verbose`, then run `pnpm check`.
- Expected: component tests complete quickly enough for routine local iteration, without individual files taking minutes.
- Actual:
  - Standalone web project: 9 files and 115 tests passed in 136.42 seconds.
  - Coverage run: total duration 256.43 seconds; aggregate test time 456.42 seconds due parallel workers.
  - Under coverage, `SettingsPanel.test.tsx` took 232.78 seconds and `App.test.tsx` took 146.74 seconds.
  - Individual SettingsPanel cases took up to 31.76 seconds; several App cases took 8-18 seconds.
- Evidence: Vitest's duration and slow-test reports in the observed runs. Node tests were materially faster; the final sequential acceptance run passed all 166 tests in 10.05 seconds.
- Impact: slow feedback discourages frequent execution and increases the chance that frontend regressions are discovered late. This is a harness performance issue, not a user-visible runtime bug.
- Suggested follow-up: profile expensive Ant Design mounting and async waits, reduce repeated full-app bootstrapping, and split broad SettingsPanel/App scenarios into smaller fixtures while retaining workflow coverage.
- Resolution: broad App and SettingsPanel suites use shared fixtures with focused wrapper files; App tests use semantic component doubles where full Ant Design behavior is irrelevant. DOM-free API/state tests run under Node. `test:web:budget` enforces 60 seconds total and 30 seconds per file; the latest run passes 100/100 in 56.64 seconds.

### QA-005: Deprecated Ant Design contracts produce repeated warnings

- Severity: Low
- Status: resolved
- Affected workflow: frontend test output and future Ant Design upgrades
- Exact reproduction: run `pnpm exec vitest run --project web` or `pnpm check` and inspect stderr.
- Expected: application tests do not repeatedly invoke deprecated component APIs.
- Actual: repeated warnings report `Drawer.width` (use `size`), `Alert.message` (use `title`), `Tabs.tabPosition` (use `tabPlacement`), and the deprecated `List` component (recommended replacement: `Listy`).
- Evidence: warnings appeared throughout `App.test.tsx` and `SettingsPanel.test.tsx`. jsdom also reported unsupported canvas, pseudo-element `getComputedStyle`, and XNotification APIs; those are environment diagnostics, not Ant Design deprecation contracts.
- Impact: no user-visible defect was observed. The volume masks more actionable stderr and indicates future framework-upgrade work.
- Suggested follow-up: migrate supported prop replacements first, evaluate the List/Listy compatibility path, and filter only known jsdom capability diagnostics after application warnings are removed.
- Resolution: deprecated Drawer, Alert, Tabs, and List contracts were migrated. Shared test setup now fails on unexpected console warnings or errors, so future deprecations cannot silently return.

### QA-006: Known ResizeObserver baseline exception was not reproduced at this SHA

- Severity: Low
- Status: resolved
- Affected workflow: web test harness reliability
- Exact reproduction: run `pnpm check` under Node.js 24 with the jsdom project.
- Expected: no unhandled `ResizeObserver` reference error; browser observer APIs used by components should have stable test doubles.
- Actual: the known baseline describes an unhandled missing `ResizeObserver` exception. It did not occur in either the standalone 115-test web run or the 281-test coverage run at the tested SHA. Relevant component files install local stubs, while the global setup does not.
- Evidence: both observed runs completed every web assertion. Their stderr contained canvas, pseudo-element style, XNotification, and deprecation warnings, but no ResizeObserver exception.
- Impact: no current failure is claimed. The baseline may be timing/order dependent because stubbing is file-local rather than guaranteed by the web project setup.
- Suggested follow-up: run the check repeatedly in CI and, if the exception recurs, install a minimal global ResizeObserver stub in the shared web test setup with a regression that verifies cleanup does not remove it.
- Resolution: shared web setup now installs stable ResizeObserver, computed-style, canvas, and Notification test doubles. Individual test files no longer own the ResizeObserver baseline.

## Tested Workflows

| Workflow | Method | Result |
| --- | --- | --- |
| Type safety | `pnpm typecheck` | Pass |
| Production build | `pnpm build` | Pass; largest JavaScript chunk is 424.73 kB and no large-chunk warning remains |
| Node behavior | `pnpm exec vitest run --project node` | Pass; includes 22 DOM-free web assertions moved from jsdom |
| Web behavior | `pnpm test:web:budget` | Pass: 100 tests in 56.64 seconds; no file exceeds 30 seconds |
| Full coverage gate | `pnpm test:coverage` | Pass: 33 files, 312 tests; all thresholds met |
| Full quality gate | `pnpm check` | Pass: typecheck, web budget, coverage, web build, and server build |
| Server boot and health | Built server, unused loopback port, fresh temporary data directory; `GET /api/health` | Pass: HTTP 200 JSON `{"ok":true}` |
| Static index and asset MIME | `GET /`, built hashed JS, and stale `/assets/index-stale.js` | Pass: HTML 200, JavaScript 200 with `application/javascript`, stale asset 404 with `text/plain` body `Asset not found` |
| SPA fallback | `GET /c/00000000-0000-4000-8000-000000000000` | Pass: HTTP 200 HTML identical in size/content to the index response |
| Workspace browser | directory list, validate, and create against the disposable data tree | Pass: canonical paths and HTTP 200/201 responses; no user directory was used |
| Settings and catalogs | settings read/update/restore; tool, plugin, skill, memory, task lists | Pass |
| Connection/model CRUD | create, list/update, and delete with an `.invalid` placeholder endpoint; no provider request | Pass; returned DTOs did not expose the placeholder API key |
| Agent and Character Card | production Agent create/update/delete; node API/storage/Card V2 JSON+PNG import/export tests | Pass |
| Conversation CRUD | create/read/update/delete and empty message list in production, bound to a disposable workspace | Pass |
| Generation and SSE | mocked provider node tests for background generation, ordered snapshots/events, cancellation, retries, and errors | Pass |
| Approval queue | node mixed-call/approval tests and web approve/deny/queue/error tests | Pass |
| Provider adapters | mocked OpenAI Chat, OpenAI Responses, and Anthropic request/stream/error tests | Pass: 28 tests |
| Workspace tools | node file/list/glob/grep/edit/shell confinement tests, relative output, and legacy input compatibility | Pass |
| Plugin and skill behavior | child-process plugin install/load/execute test and skill confinement tests; production catalog read | Pass |
| MCP behavior | mocked transport fallback/session/tool mapping plus production CRUD | Pass, including partial-update preservation and explicit header clearing |
| Background tasks | pipe, PTY, queue/quota, incremental output, terminal screen, and audit-reason tests | Pass |
| Responsive composer | jsdom desktop/mobile toolbar, gutter, settings, draft, and approval queue tests | Pass within jsdom limits |
| Markdown | math, streaming formula, code aliases/highlighting/copy, dark surface, and executable HTML sanitization | Pass: 40 tests |

## Planned Fix Verification

| Planned fix | Verification | Result |
| --- | --- | --- |
| Mixed automatic + approval completeness | `GenerationRunner tools and approval > executes every unresolved automatic and approved call once after the final approval` | Verified by passing node test. It covers a failed automatic call, an approved call, a later automatic call, one execution each, and continuation. |
| Terminal and migration behavior | `Store > migrates v12 terminal generations to complete tool result context`; `Store > settles incomplete calls when startup interrupts an active generation`; terminal/cancellation generation tests | Verified by passing node tests for migrated failed generations, startup interruption, mixed-call cancellation, and terminal results. |
| Bottom approval queue | `App > shows pending tools in index order, preserves the draft, and restores Sender after the queue`; structural inspection places `ApprovalPanel` in `.composer-rail` as the Sender replacement | Verified for DOM behavior and integration placement. Pixel-level browser positioning was not exercised. |
| Relative workspace paths | `workspace tools > returns workspace-relative paths that shell commands can use and represents the root as .`; legacy `/workspace` compatibility test | Verified by passing node tests. Returned paths feed directly into read/list/glob/shell calls, root is `.`, and legacy inputs normalize to relative outputs. |

## Additional Observations

- An exploratory run that overlapped `pnpm build` with the node suite transiently failed the stale-asset MIME assertion while Vite was cleaning/rebuilding `apps/web/dist`. The required sequential node run passed, and the production probe returned the expected text/plain 404. This was classified as a test-procedure artifact, not a product regression.
- The production server was stopped with SIGINT after the probes. All application state was created in `/tmp/llm-chat-normal-qa-data.uA96Gf`; no original project data directory was read or modified.

## 2026-08-31 Follow-up: Web Test Budget and Async Stability

The original QA baseline above measured 100 web tests in 56.64 seconds with a 60-second suite budget and a 30-second per-file budget. The integrated suite now contains 112 web tests. During integration, two 113-test runs completed in 64.30 and 61.61 seconds; after removing a duplicate render while preserving its assertions in the remaining render, 112 tests completed in 64.53 seconds. Across those three integration runs, elapsed time per test averaged approximately 0.563 seconds, compared with approximately 0.566 seconds in the original baseline. The fixed 60-second limit no longer represented the larger suite even though throughput had not regressed.

The web budget is therefore recalibrated to 70 seconds for the suite and 35 seconds per file. The budget runner still requires the Vitest process and JSON report to succeed, so the change does not permit assertion failures.

The first integrated full-coverage run passed 355 of 356 tests. Its only failure was an existing Ant Design connection-form case whose asynchronous validation message did not appear within Testing Library's default one-second async utility timeout under coverage instrumentation. The same targeted details tests passed outside that full instrumented run. Shared web test setup now configures Testing Library's async utility timeout to three seconds; cleanup and the checks for unexpected `console.warn` and `console.error` output remain enforced.

Fresh-worktree verification passed 112 of 112 web tests in 65.18 seconds, and all web tests also passed under coverage. The first fresh-worktree coverage attempt passed 355 of 356 tests; its separate failure was the server stale-asset MIME assertion. The worktree had no `apps/web/dist/index.html`, so `registerWeb` returned before installing the stale-asset and SPA fallback handlers and the request received the default JSON 404. After the frontend build generated `apps/web/dist`, the unchanged coverage command passed all 34 test files and all 356 tests, and every configured coverage threshold passed. This confirms that the async timeout stabilized the connection-form case. It also records a test-process finding: coverage verification of the server's static-asset behavior requires the frontend build artifact to exist first.

## Limitations

- No live OpenAI, Anthropic, or other external provider was called. Provider behavior was exercised with mocks.
- No real credentials were used. The MCP server was disabled and pointed to `example.invalid`; credentialed MCP connection testing was excluded.
- Credentialed web search and network MCP execution were excluded.
- No destructive operation was performed on real user data. All production CRUD used a fresh temporary data directory outside the worktree.
- No full browser automation or screenshot/layout measurement was available. Responsive composer and Markdown behavior were verified in jsdom and by integration structure, not by pixel-level desktop/mobile rendering.
- Production background task execution and production plugin installation were not repeated through live APIs; their pipe/PTY/plugin execution paths were covered by isolated node tests using disposable fixtures.
- Browser observer and notification behavior is represented by shared test doubles; real browser implementations remain outside jsdom coverage.

## Mobile streaming responsiveness — 2026-09-12

The client now publishes the first streamed block immediately and batches subsequent blocks in 50 ms windows. Status, approval, error, and completion events include pending text immediately. Message text no longer rerenders the app shell, composer, or unchanged historical messages. Scroll measurements run in a shared animation-frame callback per scroll area.

In a local production-build comparison with a 390 × 844 mobile Chromium viewport and 4× CPU slowdown, 120 cumulative text updates at 10 ms intervals produced 241 React commits before the change and 27 afterward (89% fewer). This used one conversation and one model, with offline caching disabled to isolate rendering. It does not measure a physical Android phone or provider latency.

Validation passed:

- Type checking, production build, and the web test budget: 273 tests.
- 17 mobile Chromium browser tests covering reconnects, queued sends and cancellation, draft restoration, touch scrolling, nested reasoning scrolling, typography, retry, and rich previews.
- The new `e2e/streaming-performance.spec.ts` covers both 1 and 300 configured models. It requires at least 70% fewer commits than the previous two-commits-per-block baseline and input-to-next-frame latency below 100 ms while streaming. It also checks that the complete answer and the next message draft survive completion.

Run the performance regression with `pnpm exec playwright test --project=mobile-chromium e2e/streaming-performance.spec.ts`. Per-run measurements are attached to the test results as `streaming-metrics.json` for reporters that retain attachments.
