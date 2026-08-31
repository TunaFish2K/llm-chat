# Integrated Normal-Use QA Findings

- Tested SHA: `acd7f5b798d6b0b548ece50ee6067044a1662ad8`
- Test date: 2026-08-31 (Asia/Shanghai)
- Environment: Debian GNU/Linux, Linux `6.12.105+deb13-amd64`, x86_64, Node.js `v24.20.0`, pnpm `11.7.0`
- Scope: the integrated local, single-user product; compiled server and web client; API and static serving; existing node and jsdom suites; isolated runtime data under `/tmp`

## Executive Summary

The integrated build boots and the main local workflows are broadly functional. Type checking and production builds pass. The final sequential node suite passes 166 assertions, and the web suite passes 115 assertions. The full coverage run passes all 281 assertions but `pnpm check` exits 1 at the known coverage gates, before its build phase.

One high-severity product issue was confirmed: a partial MCP server update applies create-time defaults to omitted fields, which can erase configured secret headers and unexpectedly enable a disabled server. No credentials were exposed during testing; the reproduction used placeholder values in a disposable database.

| Result class | Count | Summary |
| --- | ---: | --- |
| Passing primary gates | 4 | `typecheck`, `build`, sequential node suite, web suite |
| Failing primary gates | 1 | `pnpm check`, due only to known coverage thresholds in the observed run |
| Passing test assertions | 281 | 166 node and 115 web; the coverage run also passed 281/281 |
| Confirmed product findings | 2 | MCP partial-update data loss; oversized production JavaScript chunks |
| Baseline/harness findings | 4 | Coverage gate, long web tests, Ant Design deprecations, known ResizeObserver baseline note |

## Confirmed Findings

### QA-001: Partial MCP updates erase headers and can re-enable the server

- Severity: High
- Status: confirmed
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

### QA-003: The repository quality gate fails after all assertions pass

- Severity: Medium
- Status: baseline
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

### QA-002: Production web build emits two oversized JavaScript entry chunks

- Severity: Low
- Status: confirmed
- Affected workflow: first load and cache refresh of the local web client
- Exact reproduction: run `pnpm build` and inspect the Vite size report.
- Expected: production chunks remain below the configured 500 kB warning threshold, or the project explicitly documents and budgets larger entry payloads.
- Actual: Vite warns about chunks larger than 500 kB. The two entry chunks are 1,591.45 kB (524.55 kB gzip) and 1,980.08 kB (599.66 kB gzip), excluding source maps.
- Evidence: the build transformed 7,982 modules and printed the standard Vite large-chunk warning. The generated `apps/web/dist` directory was approximately 17 MiB including maps and assets.
- Impact: this is a performance risk rather than a demonstrated functional failure. It can increase parse/startup time and makes cold loads heavier, especially on constrained machines.
- Suggested follow-up: measure browser startup before setting a performance budget, then consider route/component-level dynamic imports or deliberate Rollup chunking.

### QA-004: Web tests have excessive duration and poor feedback time

- Severity: Low
- Status: confirmed
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

### QA-005: Deprecated Ant Design contracts produce repeated warnings

- Severity: Low
- Status: baseline
- Affected workflow: frontend test output and future Ant Design upgrades
- Exact reproduction: run `pnpm exec vitest run --project web` or `pnpm check` and inspect stderr.
- Expected: application tests do not repeatedly invoke deprecated component APIs.
- Actual: repeated warnings report `Drawer.width` (use `size`), `Alert.message` (use `title`), `Tabs.tabPosition` (use `tabPlacement`), and the deprecated `List` component (recommended replacement: `Listy`).
- Evidence: warnings appeared throughout `App.test.tsx` and `SettingsPanel.test.tsx`. jsdom also reported unsupported canvas, pseudo-element `getComputedStyle`, and XNotification APIs; those are environment diagnostics, not Ant Design deprecation contracts.
- Impact: no user-visible defect was observed. The volume masks more actionable stderr and indicates future framework-upgrade work.
- Suggested follow-up: migrate supported prop replacements first, evaluate the List/Listy compatibility path, and filter only known jsdom capability diagnostics after application warnings are removed.

### QA-006: Known ResizeObserver baseline exception was not reproduced at this SHA

- Severity: Low
- Status: baseline
- Affected workflow: web test harness reliability
- Exact reproduction: run `pnpm check` under Node.js 24 with the jsdom project.
- Expected: no unhandled `ResizeObserver` reference error; browser observer APIs used by components should have stable test doubles.
- Actual: the known baseline describes an unhandled missing `ResizeObserver` exception. It did not occur in either the standalone 115-test web run or the 281-test coverage run at the tested SHA. Relevant component files install local stubs, while the global setup does not.
- Evidence: both observed runs completed every web assertion. Their stderr contained canvas, pseudo-element style, XNotification, and deprecation warnings, but no ResizeObserver exception.
- Impact: no current failure is claimed. The baseline may be timing/order dependent because stubbing is file-local rather than guaranteed by the web project setup.
- Suggested follow-up: run the check repeatedly in CI and, if the exception recurs, install a minimal global ResizeObserver stub in the shared web test setup with a regression that verifies cleanup does not remove it.

## Tested Workflows

| Workflow | Method | Result |
| --- | --- | --- |
| Type safety | `pnpm typecheck` | Pass |
| Production build | `pnpm build` | Pass; large-chunk warning recorded as QA-002 |
| Node behavior | `pnpm exec vitest run --project node` | Pass sequentially: 14 files, 166 tests |
| Web behavior | `pnpm exec vitest run --project web --reporter=verbose` | Pass: 9 files, 115 tests; warnings and duration recorded |
| Full quality gate | `pnpm check` | Expected baseline failure after 281/281 passing tests; coverage evidence in QA-003 |
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
| MCP behavior | mocked transport fallback/session/tool mapping plus production CRUD | Transport/tool tests pass; partial-update preservation fails as QA-001 |
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

## Limitations

- No live OpenAI, Anthropic, or other external provider was called. Provider behavior was exercised with mocks.
- No real credentials were used. The MCP server was disabled and pointed to `example.invalid`; credentialed MCP connection testing was excluded.
- Credentialed web search and network MCP execution were excluded.
- No destructive operation was performed on real user data. All production CRUD used a fresh temporary data directory outside the worktree.
- No full browser automation or screenshot/layout measurement was available. Responsive composer and Markdown behavior were verified in jsdom and by integration structure, not by pixel-level desktop/mobile rendering.
- Production background task execution and production plugin installation were not repeated through live APIs; their pipe/PTY/plugin execution paths were covered by isolated node tests using disposable fixtures.
- The ResizeObserver baseline issue was not reproduced, so no current regression is claimed for it.
