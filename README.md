# Chat

`Chat` 是 `llm-chat` 的界面品牌。它是单用户、自托管的 Web LLM 聊天客户端，支持通用聊天、简单工作和角色扮演。浏览器只负责界面和实时事件订阅。服务端保存 Agent、连接密钥、模型配置、工具、草稿、消息、生成版本、界面偏好、上下文摘要和任务状态。

## 功能范围

- 支持 OpenAI Responses、OpenAI Chat Completions 和 Anthropic Messages 兼容接口。
- 支持自定义 Base URL、API Key 和秘密请求头。
- 发现模型时使用 models.dev 补全上下文、最大输入与输出、模态、工具与推理能力、推理档位、系列、发布日期和价格。手动修改技术参数后，目录更新不再覆盖该模型；可以在模型编辑器中恢复目录托管。
- 通过 SSE 流式显示正文、推理内容、用量、状态和错误。
- 助手正文支持 GFM、数学公式和受限 HTML。`content`、`StatusBlock`、`details` 及常见排版标签可用于角色卡输出；脚本、事件属性、危险 URL 和非白名单样式会被移除。
- 支持原生多步工具调用。工具调用、审批状态和结果随生成版本持久化。
- 支持 JPEG、PNG、WebP 和 GIF 图片输入。模型可声明原生图片能力；普通文本模型可由 Agent 配置备用识图模型，识图说明、用量和缓存命中会随生成记录。
- 工作区图片可通过工具导入为内容寻址的永久资源。资源 URL 包含 SHA-256，并使用不可变浏览器缓存；公网 Markdown 图片通过服务端安全代理加载。
- 内置时间、隔离 JavaScript、网页读取、SearXNG/Tavily 搜索、历史对话、长期记忆、Skills、会话工作目录和后台任务工具。
- 支持隔离的 ESM 工具 Plugin。Plugin 使用内容寻址修订，并可在运行时安装、卸载和手动重载。
- 支持 pipe 和 PTY 后台任务。Agent 可以监控完整 CLI harness，并在终端提示出现时代表用户审批或拒绝。
- 支持远程 MCP Streamable HTTP，并兼容旧 SSE 传输。
- 生成任务脱离浏览器连接运行。刷新页面后可以恢复正在进行的任务。
- 消息不可变。重新生成会创建新版本，用户可以切换活动版本。
- Agent 是独立、可复用的配置。Agent 包含角色卡、模型、上下文策略、推理强度、生成参数和工具策略。
- 会话不属于 Agent。新会话必须选择 Agent。已有会话可以切换 Agent，但切换会清除会话执行覆盖项。
- 会话可以覆盖模型、上下文策略、推理强度、生成参数和工具策略。会话不能覆盖角色提示词或用户设定。
- 每次生成保存完整的 Agent 与执行配置快照。修改 Agent 只影响后续生成。
- 支持 Character Card V2 JSON 和 PNG 导入导出。支持多行备选开场白、占位符、示例消息、历史后指令和角色 Lorebook。新会话会把开场白显示为首条助手消息；已有会话切换开场白时会从会话起点创建分支。
- 助手消息显示活动生成版本的 Agent 和模型快照。删除 Agent 或模型不会改写历史回复。
- 支持智能压缩、自动裁剪、滚动摘要和完整历史四种上下文策略。智能压缩在接近上下文预算时优先摘要，失败时按完整轮次裁剪。
- 编辑历史消息、从某轮继续和撤销上一轮都会创建新分支；原会话及工作区文件保持不变。
- 服务端使用单个 SQLite 文件，不依赖外部数据库。
- Web UI 使用 React 和原生 CSS，支持浅色、深色和系统主题。
- 桌面端使用会话、对话/轨迹、检查器三栏工作台；移动端使用导航和检查器抽屉。
- Agent、模型和推理档位是会话级控制。运行轨迹和检查器只展示服务端已持久化的数据。
- 支持安装为 PWA。应用外壳会缓存，API、消息、认证和实时事件始终使用网络。
- 使用单一访问密码保护服务。首次启动会在终端输出 8 位数字初始密码。

当前版本不包含多用户或 Android 设备专属能力（剪贴板、日历、屏幕时长、TTS）。附件目前只支持图片。

## 环境要求

- Node.js 24 或更高版本
- pnpm 11

本项目使用 Node.js 内置的 `node:sqlite`，不需要编译原生数据库依赖。

## 开发

```bash
pnpm install
pnpm dev
```

开发模式下：

- Web：`http://127.0.0.1:5173`
- API：`http://127.0.0.1:3000`

Vite 只把 `/api` 代理到服务端。Web 不直接请求模型提供方。

## 生产运行

生产启动前必须构建 Web 和服务端产物。配置项 `serveWeb` 默认是 `true`，此时
`apps/web/dist/index.html` 必须存在；构建产物缺失会阻止服务启动。

```bash
pnpm build
pnpm start
```

默认访问地址是 `http://127.0.0.1:3000`。服务端会同时提供 API 和构建后的 Web 静态文件。
外部管理器、HTTPS 反向代理和数据目录布局请参阅[部署运维手册](docs/DEPLOYMENT.md)。本仓库不生成
`served`、容器、systemd 或 nginx 配置。

首次执行 `pnpm start` 时，如果项目根目录没有 `config.json`，服务会生成以下完整默认配置并继续
启动。该文件是明文 JSON，不做应用层加密；生成权限为 `0600`。也可以执行
`pnpm start --config /etc/llm-chat/config.json` 使用其他路径。显式路径的父目录必须已经存在。

| 配置项 | 默认值 | 用途 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 监听地址 |
| `port` | `3000` | HTTP 端口 |
| `dataDir` | `./data` | 完整持久化数据目录；相对路径按配置文件所在目录解析 |
| `authMode` | `password` | 认证模式。`disabled` 只允许使用回环监听地址，且不得通过代理公开 |
| `trustProxy` | `false` | `true` 启用代理信任；也可以填写 Fastify 接受的代理地址或 CIDR 字符串 |
| `serveWeb` | `true` | 是否提供 `apps/web/dist` 静态文件；设为 `false` 时只运行 API |
| `shutdownTimeoutMs` | `30000` | 应用关闭总期限，允许 `1000` 到 `300000` 毫秒 |
| `buildId` | `development` | 1 到 200 个字符的单行构建标识；出现在启动日志和探针响应中 |

内网 HTTP 部署可将 `config.json` 改为：

```json
{
  "host": "0.0.0.0",
  "port": 3000,
  "dataDir": "/srv/llm-chat/data",
  "authMode": "password",
  "trustProxy": false,
  "serveWeb": true,
  "shutdownTimeoutMs": 30000,
  "buildId": "release-2026-09-03"
}
```

密码认证允许从 localhost、回环 IP、内网 IP 或反向代理域名访问，无需声明公开地址。HTTP 会明文传输
密码和会话，不防止窃听或中间人攻击。需要传输安全时，仍应在可信反向代理后使用 HTTPS。
`authMode: "disabled"` 不是远程部署选项。

`/healthz` 是无数据库查询的存活探针，服务监听后返回 HTTP `200` 和 `{ "ok": true, "buildId": "..." }`。
`/readyz` 是流量探针：启动完成、SQLite 可执行 `SELECT 1` 且（`serveWeb: true` 时）Web
入口存在时返回 `200`；启动尚未完成、检查失败或关闭排空期间返回 `503`。两个响应都会包含
`buildId`。关闭时先撤回 readiness，因此管理器必须按 `/readyz` 摘流量，并为
`shutdownTimeoutMs` 留出更长的停止宽限期。

## 密码登录

首次启动新的数据目录时，终端会输出一个 8 位数字初始密码。打开应用并输入该密码即可登录。初始密码
只生成并输出一次；登录后可在“设置 > 安全”修改。修改密码会撤销其他浏览器的会话，当前浏览器继续
保持登录。会话使用 180 天滑动有效期的 `HttpOnly`、`SameSite=Strict` Cookie。

手动浏览器矩阵应覆盖各平台可获得的当前版本：

| 环境 | 说明 |
| --- | --- |
| 桌面 Chrome | 支持密码登录和网页功能；桌面自动化使用 Playwright Chromium |
| 桌面 Firefox | 支持密码登录和网页功能，但没有标准的 PWA 安装入口 |
| 桌面 Safari | 支持密码登录和网页功能；自动化使用 Playwright WebKit 覆盖 |
| Android Chrome、Android Firefox（平台提供时） | 支持密码登录和网页功能；移动自动化覆盖 390x844 Chromium |
| iOS Safari（以及平台提供的其他浏览器） | iOS 上通过 Safari 安装 PWA；移动浏览器能力以当前系统版本为准 |

自动化门禁覆盖 Playwright Chromium、Firefox、WebKit 桌面项目，以及 `390x844` 的移动 Chromium。
所有浏览器项目都执行真实密码登录。非本机 HTTP 通常不能注册 Service Worker，因此普通网页可用，
但 PWA 安装和离线外壳不作保证。

## 首次配置

1. 打开“设置 > 连接与模型”，添加一个提供方连接。Base URL 应包含 API 版本前缀，例如 `https://api.openai.com/v1`。
2. 测试连接，并使用“发现模型”导入模型；也可以手工添加模型 ID。
3. 检查自动补全的模型限制。只有目录未匹配时，才需要为自动裁剪或摘要手工填写上下文窗口。
4. 打开“Agent”，为“默认助手”选择模型。
5. 按需编辑角色设定、用户设定、生成参数和工具策略。
6. 新建会话，并在发送第一条消息前选择 Agent 和开场白。

## Agent 与会话

应用首次启动时会创建“默认助手”。可以编辑该 Agent，但不能删除它。新会话默认选择服务端记录的上次使用 Agent。首次使用时选择“默认助手”。

Agent 修改后，选择该 Agent 的会话会在下一次生成时读取新配置。正在运行的生成继续使用创建任务时的快照。历史生成也保留原快照。

会话切换 Agent 后会保留全部消息。应用不会插入新开场白。下一次生成使用新 Agent。删除普通 Agent 后，引用它的会话仍会保留，但必须重新选择 Agent 才能发送消息。

开场白在首次发送时连同全部候选项和 Agent 修订一起保存。以后修改角色卡不会改写历史开场白。切换历史开场白会创建仅包含所选开场白的新根分支，原会话保持不变。

导入角色卡时，应用总是创建副本。没有 `extensions.llm_chat` 的角色卡会复制“默认助手”的执行配置。导出文件不会包含内部 ID、API Key、秘密请求头或 MCP 凭据。

## 工具配置

打开 Agent 的“工具”与“Skill”页管理搜索服务、启用状态、直接性、三态审批策略和后台资源额度。每个 Agent 只能选择一个搜索服务：SearXNG 或 Tavily；搜索 API Key 只通过服务端保存。打开“设置”管理全局工具、Plugins、Skills 和 MCP。全局 Skill 页不删除来源目录；删除或卸载应交给对应的外部包管理器。

- 搜索工具按 Agent 配置调用 SearXNG JSON 接口或 Tavily `/search` 接口。SearXNG 需要填写服务地址；Tavily 使用 `https://api.tavily.com` 作为默认地址并需要 API Key。配置完成后工具才会注入模型。
- `coding-supervisor` Skill 优先通过 Codex app-server 管理编码任务；如果 Codex 不可用，回退到通用后台任务。任务页可以发现并接管已有 thread、发送任务、查看结构化事件、处理审批和中断 turn。
- Codex 默认使用 `server-workspace` 策略。仅在服务端设置 `LLM_CHAT_CODEX_PROFILE=trusted-local-yolo` 时，`trusted-local-yolo` 选项才会生效；部署到其他服务器时应保留默认策略。`LLM_CHAT_CODEX_BIN` 和 `LLM_CHAT_CODEX_SOCKET` 可覆盖 Codex 可执行文件与已有 app-server socket。
- 新会话可以不绑定工作目录，也可以从服务端目录浏览器选择任意现有可访问目录。旧会话迁移到 `dataDir/workspace`。
- 文件、Shell 和后台任务工具只访问生成快照中固定的会话工作目录。
- `background_start`、`background_write` 和 `background_stop` 默认需要审批；读取和等待默认自动执行。
- 写文件、编辑文件、隔离 JavaScript 和具有副作用的 MCP 工具默认需要批准。
- Skills 由服务端托管并按 Agent 启用。服务启动和 `POST /api/skills/discover` 只扫描当前系统用户 `~/.agents/skills` 的直接子目录。发现的 Agent Skills 使用 `agents.<name>` 内部 ID，并保存内容寻址修订。
- 模型通过 `use_skill` 按需加载固定 Skill 修订。标准 `allowed-tools` 只作为 Skill 内容保留，不会启用工具或绕过审批。
- Agent 可把已启用工具设为直接或惰性。直接工具在第一步提供给模型；惰性工具由内部 `search_tools` 按需发现，并且仍受 Agent 启用状态、可用性和审批策略限制。
- Plugin 源目录安装后会复制到 `dataDir/plugins`。Plugin 是可信本地代码；独立子进程只提供故障隔离，不限制主机权限。
- 任意 URL 读取会阻止回环、私网地址和重定向到私网的请求。

MCP 名称只允许英文字母和数字。秘密请求头只保存在 SQLite 中，查询接口只返回请求头名称。远程 MCP 工具按 `mcp__服务名__工具名` 注册；只有明确声明 `readOnlyHint` 的工具会自动执行。

API Key 和秘密请求头不会通过查询接口返回。SQLite 文件仍包含这些凭据，服务端会尽量把数据目录和文件权限设为仅当前系统用户可读写。备份该文件时应按密钥材料处理。

## 安全边界

这是单用户应用。共享密码只控制是否能够进入应用，不提供多用户隔离。当前操作者能够浏览服务端目录、
运行进程和安装可信 Plugin。HTTP 下密码和会话可能被同一网络中的其他设备截获；该模式只适用于用户接受
这一风险的网络。需要安全边界时应使用 HTTPS 或其他受信传输层。

浏览器不使用 `localStorage`、`sessionStorage` 或 IndexedDB 保存聊天和认证状态。PWA 的 Cache Storage
只保存构建后的应用外壳。模型请求、上下文拼装、摘要生成、工具执行、审批和取消操作都发生在服务端。

## 数据与恢复

`dataDir` 指向的目录是唯一的运行数据备份和恢复单元，不能只备份 `llm-chat.sqlite`。目录包含 SQLite
文件及其可能存在的 `-wal`/`-shm` 旁车文件、Plugin 和 Skill 的内容寻址修订、后台任务日志、持久化
的大型工具输出、内容寻址图片资产，以及工作目录和其他服务端状态。该目录的 SQLite 还包含 API Key、秘密请求头、密码
哈希和会话相关材料；整个目录必须按密钥材料保护。

简单且受支持的备份/恢复流程要求服务已停止，并且在备份或恢复期间没有其他进程使用该目录。停止后
原样复制或归档整个 `dataDir`，恢复时将完整目录恢复到同一路径并保持权限；不要把新旧目录
内容混合。生成任务只在单个服务进程内执行；服务异常退出后，正在请求模型或执行工具的任务会在下次
启动时标记为中断，不会自动重放模型请求。

## 离线认证恢复

服务停止后，在项目或发布目录执行以下命令。CLI 只接受 `--config <path>` 和
`--confirm-reset-password`；不要添加额外的 `--`：

```bash
pnpm --filter @llm-chat/server auth:reset \
  --config /etc/llm-chat/config.json \
  --confirm-reset-password
```

密码重置不会生成缺失的配置文件。该 CLI 先读取配置中的 `dataDir`，再取得与服务相同的数据目录实例锁，
因此服务运行时会拒绝执行。它会设置新的 8 位数字密码并
撤销所有登录会话，同时保留聊天、Agent、连接和工具数据。成功输出包含新密码和撤销的会话数量。

## 检查与 CI

CI 使用 Node.js 24、pnpm 11.7.0 和冻结安装。对应命令顺序如下：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm audit --prod
pnpm test:deploy
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm test:e2e
```

`pnpm check` 依次运行 TypeScript 类型检查、Web 预算检查、覆盖率测试和生产构建；部署 smoke test
验证构建后的服务、探针、静态资源、实例锁、关闭排空、后台任务回收和离线认证重置。

## 目录

```text
apps/server/        Fastify API、SSE、任务调度、上下文和 SQLite
apps/web/           React 界面，仅通过同源 API 访问服务端
packages/contracts/ 前后端共享的 Zod 契约与类型
packages/providers/ 模型提供方协议适配器
```
