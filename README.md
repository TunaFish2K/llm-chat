# llm-chat

单用户、自托管的 Web LLM 聊天客户端。它支持通用聊天、简单工作和角色扮演。浏览器只负责界面和实时事件订阅。服务端保存 Agent、连接密钥、模型配置、工具、草稿、消息、生成版本、界面偏好、上下文摘要和任务状态。

## 功能范围

- 支持 OpenAI Responses、OpenAI Chat Completions 和 Anthropic Messages 兼容接口。
- 支持自定义 Base URL、API Key 和秘密请求头。
- 通过 SSE 流式显示正文、推理内容、用量、状态和错误。
- 支持原生多步工具调用。工具调用、审批状态和结果随生成版本持久化。
- 内置时间、隔离 JavaScript、网页读取、SearXNG 搜索、历史对话、长期记忆、Skills 和沙箱工作区工具。
- 支持远程 MCP Streamable HTTP，并兼容旧 SSE 传输。
- 生成任务脱离浏览器连接运行。刷新页面后可以恢复正在进行的任务。
- 消息不可变。重新生成会创建新版本，用户可以切换活动版本。
- Agent 是独立、可复用的配置。Agent 包含角色卡、模型、上下文策略、推理强度、生成参数和工具策略。
- 会话不属于 Agent。新会话必须选择 Agent。已有会话可以切换 Agent，但切换会清除会话执行覆盖项。
- 会话可以覆盖模型、上下文策略、推理强度、生成参数和工具策略。会话不能覆盖角色提示词或用户设定。
- 每次生成保存完整的 Agent 与执行配置快照。修改 Agent 只影响后续生成。
- 支持 Character Card V2 JSON 和 PNG 导入导出。支持开场白切换、占位符、示例消息、历史后指令和角色 Lorebook。
- 助手消息显示活动生成版本的 Agent 和模型快照。删除 Agent 或模型不会改写历史回复。
- 支持完整历史、自动裁剪和滚动摘要三种上下文策略。
- 服务端使用单个 SQLite 文件，不依赖外部数据库。
- Web UI 使用 Ant Design X 和 Ant Design 组件，支持浅色、深色和系统主题。

当前版本不包含多用户、登录、附件或 Android 设备专属能力（剪贴板、日历、屏幕时长、TTS）。

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

```bash
pnpm build
pnpm start
```

默认访问地址是 `http://127.0.0.1:3000`。服务端会同时提供 API 和构建后的 Web 静态文件。

可用环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `LLM_CHAT_HOST` | `127.0.0.1` | 监听地址 |
| `LLM_CHAT_PORT` | `3000` | HTTP 端口 |
| `LLM_CHAT_DATA_DIR` | `./data` | SQLite 数据目录 |

例如：

```bash
LLM_CHAT_PORT=3100 LLM_CHAT_DATA_DIR=/srv/llm-chat pnpm start
```

## 首次配置

1. 打开“设置 > 连接”，添加一个提供方连接。Base URL 应包含 API 版本前缀，例如 `https://api.openai.com/v1`。
2. 测试连接，并使用“发现模型”导入模型；也可以在“模型”页手工添加模型 ID。
3. 对需要自动裁剪或摘要的模型填写上下文窗口。
4. 打开“设置 > Agent”，为“默认助手”选择模型。
5. 按需编辑角色设定、用户设定、生成参数和工具策略。
6. 新建会话，并在发送第一条消息前选择 Agent 和开场白。

## Agent 与会话

应用首次启动时会创建“默认助手”。可以编辑该 Agent，但不能删除它。新会话默认选择服务端记录的上次使用 Agent。首次使用时选择“默认助手”。

Agent 修改后，选择该 Agent 的会话会在下一次生成时读取新配置。正在运行的生成继续使用创建任务时的快照。历史生成也保留原快照。

会话切换 Agent 后会保留全部消息。应用不会插入新开场白。下一次生成使用新 Agent。删除普通 Agent 后，引用它的会话仍会保留，但必须重新选择 Agent 才能发送消息。

导入角色卡时，应用总是创建副本。没有 `extensions.llm_chat` 的角色卡会复制“默认助手”的执行配置。导出文件不会包含内部 ID、API Key、秘密请求头或 MCP 凭据。

## 工具配置

打开“设置 > 工具”管理内置工具和 MCP 服务。

- 搜索工具使用 SearXNG JSON 接口。填写服务地址后工具才会注入模型。
- 工作区位于 `LLM_CHAT_DATA_DIR/workspace`。文件工具不能访问该目录之外的路径。
- Shell 默认关闭。开启后，每条命令仍需要在消息中明确批准。
- 写文件、编辑文件、隔离 JavaScript 和具有副作用的 MCP 工具默认需要批准。
- Skills 位于 `LLM_CHAT_DATA_DIR/skills/<skill-name>/SKILL.md`，由模型按需加载。
- 任意 URL 读取会阻止回环、私网地址和重定向到私网的请求。

MCP 名称只允许英文字母和数字。秘密请求头只保存在 SQLite 中，查询接口只返回请求头名称。远程 MCP 工具按 `mcp__服务名__工具名` 注册；只有明确声明 `readOnlyHint` 的工具会自动执行。

API Key 和秘密请求头不会通过查询接口返回。SQLite 文件仍包含这些凭据，服务端会尽量把数据目录和文件权限设为仅当前系统用户可读写。备份该文件时应按密钥材料处理。

## 安全边界

这是单用户应用，服务端没有登录层。默认只监听回环地址。不要直接把端口暴露到局域网或公网；如需远程访问，应在反向代理或零信任网关上配置 TLS 和身份验证。

浏览器不使用 `localStorage`、`sessionStorage` 或 IndexedDB 保存应用状态。页面 URL 只包含当前会话 ID。模型请求、上下文拼装、摘要生成、工具执行、审批和取消操作都发生在服务端。

## 数据与恢复

默认数据库位于 `data/llm-chat.sqlite`。备份时应同时停止服务，或使用支持 SQLite 在线备份的工具。生成任务只在单个服务进程内执行；服务异常退出后，正在请求模型或执行工具的任务会在下次启动时标记为中断，不会自动重放模型请求。

## 检查

```bash
pnpm check
```

该命令依次运行 TypeScript 类型检查、Vitest 测试和生产构建。

## 目录

```text
apps/server/        Fastify API、SSE、任务调度、上下文和 SQLite
apps/web/           React 界面，仅通过同源 API 访问服务端
packages/contracts/ 前后端共享的 Zod 契约与类型
packages/providers/ 模型提供方协议适配器
```
