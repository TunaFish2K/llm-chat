# Chat

[中文](README.md)

## Introduction

Chat is a single-user, self-hosted web client for AI conversations. The repository name is `llm-chat`. The server stores conversations, Agents, model settings, credentials, attachments, and tasks. The browser displays messages and live events.

- Connect to OpenAI Responses, Chat Completions, and Anthropic Messages compatible APIs. Use provider presets or custom addresses and secret headers.
- Stream answers, reasoning summaries, tool calls, and usage. Render Markdown, tables, math, and restricted HTML.
- Upload images and files. Generate images through Responses conversations or a separate image tool.
- Configure Agents, character cards, context policies, fallback vision models, tool permissions, and Skills. Import and export Character Card V2 JSON and PNG files.
- Use search, web readers, memories, files, Shell, background tasks, MCP, and Plugins. Agents can delegate coding tasks through Codex app-server.
- Keep answer versions and conversation branches. Undo and redo change active history without creating a branch.
- Submit several queued messages during generation. The server stores the queue. Delete individual items or clear the queue.
- Use the desktop or mobile interface, or install the PWA. The server preserves branch selections across devices.

Chat uses SQLite and needs no external database. It does not provide separate users or user isolation.

## Deployment and use

### Requirements and startup

Install Node.js 24 or later and pnpm 11.7.0.

1. Clone the repository.

   ```bash
   git clone https://github.com/TunaFish2K/llm-chat.git
   ```

2. Enter the project directory.

   ```bash
   cd llm-chat
   ```

3. Install dependencies.

   ```bash
   pnpm install --frozen-lockfile
   ```

4. Build the application.

   ```bash
   pnpm build
   ```

5. Start the server.

   ```bash
   pnpm start
   ```

6. Open `http://127.0.0.1:3000` and enter the eight-digit initial password from the first startup log.

The first startup creates `config.json` with mode `0600`. The default address accepts local connections only. Use `pnpm start --config /etc/llm-chat/config.json` for an external configuration file. Its parent directory must exist.

| Setting | Default | Purpose |
| --- | --- | --- |
| `host` | `127.0.0.1` | Listening address |
| `port` | `3000` | HTTP port |
| `dataDir` | `./data` | Data directory, relative to the configuration file |
| `authMode` | `password` | Password authentication is required for remote access |
| `trustProxy` | `false` | Enable only behind a trusted reverse proxy |
| `serveWeb` | `true` | Serve the built web application |
| `shutdownTimeoutMs` | `30000` | Shutdown deadline in milliseconds |
| `buildId` | `development` | Release identifier in logs and probes |

Change the listening address for remote deployment. HTTP sends passwords and sessions without encryption. Use HTTPS through a trusted reverse proxy for transport security. PWA installation and updates require a browser-supported secure context. Do not expose a server with `authMode: "disabled"`.

See the [deployment manual](docs/DEPLOYMENT.md) for process management, reverse proxies, probes, and password recovery. The manual is in Chinese.

### Models and Agents

1. Add a connection under Settings → Connections and models (设置 → 连接与模型).
2. Select a provider and enter its API key. A custom service also needs an address and protocol.
3. Discover or add models, then check their capabilities. Catalog matches supply technical defaults. Manual edits stop automatic catalog updates for that model.
4. Select a model for the default assistant under Agent.
5. Create a conversation and send a message.

An Agent stores reusable character settings and execution policies. A conversation can select another Agent or override its model and reasoning level. Changing the Agent clears conversation execution overrides. Each generation keeps a configuration snapshot. Later edits do not change historical answers.

### Search and image generation

Settings → Search engines (设置 → 搜索引擎) configures SearXNG and Tavily globally. You can enable both. SearXNG needs a service address and its JSON search API. Tavily needs an API key. An empty Tavily address uses the official default endpoint.

The server migrates existing Agent search settings into the global list. It preserves unused credentials as disabled entries.

Settings → Image generation (设置 → 图片生成) controls the models available to the image tool. First enable image output and configure an image protocol under Connections and models. Move entries up or down to save the recommended order. The AI can choose any enabled entry. Without a selector, the tool uses the first available entry.

The Agent tool page still controls tool permissions and approval policies. The AI can discover search engines with `search_web({"action":"list_engines"})`. To search, supply `query` and an optional `engine_id`.

The AI can discover image models with `image_generate({"action":"list_models"})`. To generate an image, supply `prompt` and an optional `model_id`. Identifiers resemble `openai/gpt-image-2`. Use the returned identifier. Duplicate names receive distinct identifiers. Renaming and reordering preserve existing identifiers.

You can also select an image model directly for a Responses conversation. That path requires image output capability. Image tool switches do not affect it.

### Undo, queued messages, and attachments

The composer menu contains Undo last turn (撤回上一轮), Redo (重做), and Recovery records (恢复记录). Rewind to this turn (回溯至此轮) keeps the selected whole turn and removes later turns from active history.

Redo restores the original messages, answer versions, and attachments. It does not call the model or execute tools again.

Sending a new message after undo ends the old redo path. Recovery records still let you view and copy old content. You can restore a user message and its attachments as a draft. Restoration does not overwrite an existing draft. Editing historical messages and continuing from a branch point still create branches.

Rewind pauses the queue and stops active generations and image jobs. Queued messages remain available. Select Continue sending (继续发送) to resume automatic dispatch. Rewind does not revert workspace files, Codex threads, memories, or independent background tasks.

When the context exceeds the Agent image limit, the server can replace older images with cached text descriptions. It retains the original attachments.

### Optional tools

`browser_fetch` uses headless Firefox to read pages after JavaScript execution. It needs no graphical desktop. Install the browser as the service user:

```bash
pnpm --filter @llm-chat/server exec playwright-core install firefox
```

Then enable the browser tool for the Agent. It does not retain login sessions or solve CAPTCHAs. It cannot guarantee access to blocked websites.

The Codex integration manages threads, tasks, approvals, and interrupts through app-server. Its default policy is `server-workspace`. `LLM_CHAT_CODEX_BIN` and `LLM_CHAT_CODEX_SOCKET` select the executable and an existing socket. The relaxed policy requires `LLM_CHAT_CODEX_PROFILE=trusted-local-yolo` on the server.

At startup, the server discovers direct subdirectories of the service user's `~/.agents/skills`. Agents load enabled Skills when needed. Plugins are trusted local code. Their subprocesses do not restrict host permissions. File and Shell tools use the conversation workspace from the generation snapshot.

### Updates and backups

Settings → General → Application update (设置 → 通用 → 应用更新) checks the frontend version for this device. Select Update and refresh (更新并刷新) when the update is ready. This action does not fetch source code or update the server.

Server updates require dependency installation, a new build, and a restart. Only one server process can use a data directory. Before an update, stop the server and back up the complete `dataDir`, configuration file, and process manager configuration. Do not copy only SQLite or combine old and new data directories.

Database migrations move forward. An old release may reject the new schema. Rollback requires a compatible release and a complete backup. The database contains credentials. Protect backups as secret material.

## Development

After installing dependencies, run:

```bash
pnpm dev
```

The web address is `http://127.0.0.1:5173`. The API address is `http://127.0.0.1:3000`. Vite proxies `/api` requests to the server. The browser does not contact model providers directly.

| Directory | Contents |
| --- | --- |
| `apps/server` | Fastify API, SQLite, generation scheduling, and tools |
| `apps/web` | React interface and plain CSS |
| `packages/contracts` | Shared Zod contracts and types |
| `packages/providers` | Model protocol adapters |
| `e2e` | Isolated servers and browser regression tests |

`pnpm check` runs type checks, the web test budget, production builds, and coverage tests, in that order. You can run other checks separately:

```bash
pnpm test
pnpm audit --prod
pnpm test:deploy
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm test:e2e
```

Deployment tests need build artifacts. Browser tests use temporary data directories and do not access production data. See [CONTEXT.md](CONTEXT.md) for domain terminology.

## Statement

This project uses the [Unlicense](LICENSE). You may use, copy, modify, and distribute it, including for commercial purposes. The software comes without warranty. The LICENSE file contains the full terms.

Third-party dependencies, icons, and services retain their own licenses and terms. The Unlicense does not replace those terms. Model services may charge fees. Users must check model output.
