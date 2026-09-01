# 生产部署运维手册

本手册面向用户自己的 `served` 管理器。管理器负责启动、停止、重启、单副本约束和停止宽限期；可选的
HTTPS 反向代理负责证书、TLS 和对外入口。本仓库不生成 `served`、容器、systemd 或 nginx 配置，也不替
运维者选择具体的管理器或代理。

## 运行约束

- 每个 `LLM_CHAT_DATA_DIR` 只能有一个 llm-chat 进程。不要让两个副本使用同一个目录，即使端口不同。
- 重启必须先停止旧进程并等待它退出，再启动新进程。锁会在应用完成关闭后释放；不要用删除锁文件的方式
  绕过占用检查。
- 发布代码和 `apps/web/dist` 是不可变发布产物。`LLM_CHAT_DATA_DIR` 是独立的、可写的持久化目录。
  Plugin、Skill 修订、任务日志和工具输出都在该目录内。
- 远程访问必须使用密码认证。纯 HTTP 可运行，但不能保护密码和会话免受网络窃听。

## 前置条件

准备以下内容：

1. Node.js 24 或更高版本，以及 pnpm 11.7.0。
2. 一个由服务账号拥有且可写的持久化数据目录，例如 `/srv/llm-chat/data`。目录权限应限制为服务账号；
   数据目录包含密钥和用户数据。
3. 一个独立的发布目录。发布完成后不要在该目录中改写源码或构建产物。
4. 可选的 DNS、TLS 证书和可信 HTTPS 代理。纯内网 HTTP 部署不要求这些组件。
5. 管理器的停止宽限期。它必须严格大于 `LLM_CHAT_SHUTDOWN_TIMEOUT_MS` 的值，并且不能在该期限前
   发送 `SIGKILL`。

## 安装和构建

在新的发布目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` 先构建 Web，再构建服务端，并生成 `apps/web/dist/index.html`、`apps/server/dist/index.js`
和 `apps/server/dist/auth-reset.js`。默认 `LLM_CHAT_SERVE_WEB=true`，所以缺少 Web 入口时服务不会启动。
完成验证后，将整个发布目录作为不可变代码版本交给管理器；不要把可写数据目录放进代码发布目录。

质量门禁见[验证和 CI](#验证和-ci)。`pnpm test:deploy` 需要已经构建的服务端产物；新检出目录可先执行
`pnpm check` 或上面的 `pnpm build`。

## 启动环境

从发布目录根执行 `pnpm start`。下面是一个内网 HTTP 服务的完整示例：

```bash
LLM_CHAT_HOST=0.0.0.0 \
LLM_CHAT_PORT=3000 \
LLM_CHAT_DATA_DIR=/srv/llm-chat/data \
LLM_CHAT_AUTH_MODE=password \
LLM_CHAT_PUBLIC_URL=http://192.168.1.10:3000 \
LLM_CHAT_SERVE_WEB=true \
LLM_CHAT_SHUTDOWN_TIMEOUT_MS=30000 \
LLM_CHAT_BUILD_ID=release-2026-09-01 \
pnpm start
```

将示例 IP 改为浏览器实际访问的内网地址。`LLM_CHAT_PUBLIC_URL` 只能包含协议、主机和端口，不能包含
路径、查询或 fragment。使用反向代理时，再设置与实际代理源匹配的 `LLM_CHAT_TRUST_PROXY`。

运行时配置的默认值和解析规则如下：

| 变量 | 默认值 | 规则 |
| --- | --- | --- |
| `LLM_CHAT_HOST` | `127.0.0.1` | 监听地址；`disabled` 认证时必须是回环地址 |
| `LLM_CHAT_PORT` | `3000` | 1 到 65535 的整数 |
| `LLM_CHAT_DATA_DIR` | 项目根目录下的 `data` | 解析为绝对路径；与其他进程共享会触发实例锁 |
| `LLM_CHAT_AUTH_MODE` | `password` | 只能是 `password` 或 `disabled` |
| `LLM_CHAT_PUBLIC_URL` | `http://localhost:<端口>` | 只能是 origin，用于校验写请求来源 |
| `LLM_CHAT_TRUST_PROXY` | `false` | `true` 启用代理信任；`false` 或未设置关闭；其他非空字符串原样作为代理地址/CIDR 规则传给 Fastify |
| `LLM_CHAT_SERVE_WEB` | `true` | 只能是 `true` 或 `false`；`false` 时 API 不提供 Web 静态文件 |
| `LLM_CHAT_SHUTDOWN_TIMEOUT_MS` | `30000` | 只能是无前导零的整数，范围 1000 到 300000 毫秒 |
| `LLM_CHAT_BUILD_ID` | `development` | 1 到 200 个字符的非空单行文本 |

`LLM_CHAT_AUTH_MODE=disabled` 有严格的双重回环限制：监听地址和 `LLM_CHAT_PUBLIC_URL` 的主机名都必须
是 `localhost`、`::1` 或 `127.0.0.0/8`。例如 `0.0.0.0`、域名公开 URL 或代理后的远程 URL 都会在启动
前被拒绝。远程访问应使用 `password` 模式，并设置浏览器实际访问的公开 URL。

若只需要 API，可以显式设置 `LLM_CHAT_SERVE_WEB=false`；此时不要求 Web 入口，`/readyz` 也不会检查
Web 文件。浏览器 UI 和通常的生产部署应保留 `true`。

## 锁和副本

进程启动的第一步是为规范化后的数据目录取得实例锁，然后才创建 `Store` 和 SQLite。锁使用数据目录
中的 `.llm-chat-instance` 标记文件；同一目录的绝对路径、相对路径或符号链接别名都不能绕过它。占用
时启动会失败并报告数据目录已被另一个 llm-chat 进程占用。

因此，`served` 必须配置一个副本，并将滚动更新实现为停止旧进程、确认其退出、启动新进程的顺序。不能
让新旧进程重叠，也不能用不同端口规避锁。离线认证重置 CLI 也取得同一把锁，所以必须遵守相同的停服
要求。

## HTTP 边界和探针

浏览器访问的 origin 必须与 `LLM_CHAT_PUBLIC_URL` 一致。服务可以直接监听内网地址，也可以位于反向代理
之后。密码和会话 Cookie 在纯 HTTP 中可能被截获；需要传输安全时应使用 HTTPS 代理。

管理器应使用以下端点：

```bash
curl -sS -i http://127.0.0.1:3000/healthz
curl -sS -i http://127.0.0.1:3000/readyz
```

- `/healthz` 是存活探针。服务开始监听后返回 HTTP `200`、`ok: true` 和当前 `buildId`，不执行 SQLite
  查询。关闭排空时它仍可能返回 `200`，所以不要用它决定是否继续接收流量。
- `/readyz` 是就绪和流量探针。启动完成后，它检查 SQLite 的 `SELECT 1`；`serveWeb=true` 时还检查
  `apps/web/dist/index.html`。通过时返回 HTTP `200`、`ok: true` 和 `buildId`；启动未完成、检查失败
  或关闭排空时返回 HTTP `503`、`ok: false` 和 `buildId`。

关闭收到 `SIGTERM` 后会立即撤回 readiness。应用先中止并等待活动生成，再关闭后台任务、Plugin/MCP
资源、Fastify 和 SQLite，最后释放实例锁。后台任务先向进程组发送 `SIGTERM`，单个任务最多等待 2 秒；
仍未退出时发送 `SIGKILL`。`LLM_CHAT_SHUTDOWN_TIMEOUT_MS` 是整个应用关闭的上限，超时会强制退出。
管理器宽限期必须严格超过此值，并应使用 `/readyz` 先摘流量。

## 更新和回滚

更新时先在新的发布目录安装依赖并构建，给它设置新的 `LLM_CHAT_BUILD_ID`，然后按停服顺序切换管理器：

1. 停止旧进程，等待旧进程退出并确认旧数据目录不再被占用。
2. 启动新发布目录中的 `pnpm start`，使用完全相同的 `LLM_CHAT_DATA_DIR` 和其他运行时环境。
3. 轮询 `/readyz`，确认 HTTP `200` 且响应中的 `buildId` 是新值；再把流量切换到新进程。

回滚使用同样的停服和单副本顺序，选择以前的不可变发布目录并保留同一个数据目录。启动前确认该版本
支持当前数据库架构；数据库迁移在启动时向前执行，旧版本可能拒绝比它更新的数据库版本，不要假设可以
自动降级。若需要回到迁移前状态，停止服务并恢复更新前保存的完整数据目录备份。

## 停服备份和恢复

`LLM_CHAT_DATA_DIR` 是唯一的备份/恢复单元，不能只复制 `llm-chat.sqlite`。除了 SQLite 及其
`-wal`/`-shm` 旁车文件，目录还保存：

- Plugin 内容寻址修订和配置材料；
- Skill 内容寻址修订、发现源副本和内置 Skill；
- `tasks/<task-id>/` 下的后台任务日志；
- `tool_outputs/` 下超过内存返回上限后持久化的大型工具输出；
- 工作目录和其他服务端状态。

SQLite 还包含 API Key、秘密请求头、密码哈希和会话相关材料。整个目录必须按秘密材料保护，不要把归档
上传到不受控的位置。

简单且受支持的流程必须在服务完全停止后执行：

1. 让 `served` 摘除 readiness，发送停止信号，并等待进程退出。确认没有第二个进程使用该数据目录。
2. 原样归档完整目录。例如数据目录是 `/srv/llm-chat/data` 时：

   ```bash
   tar --create --file /srv/llm-chat/backup/llm-chat-data.tar \
     --directory /srv/llm-chat data
   ```

3. 恢复时保持管理器停止，将现有目录移出目标路径，再把归档完整解包回 `/srv/llm-chat/data`；保持服务
   账号所有者和目录/文件权限，不要将新旧目录内容混合。例如：

   ```bash
   mv /srv/llm-chat/data /srv/llm-chat/data.before-restore
   tar --extract --file /srv/llm-chat/backup/llm-chat-data.tar \
     --directory /srv/llm-chat
   ```

4. 使用同一个 `LLM_CHAT_DATA_DIR` 启动服务，检查 `/healthz` 和 `/readyz`，再恢复流量。

不要在服务运行时用普通文件复制替换 SQLite，也不要只恢复数据库而遗漏修订、任务日志或工具输出。

## 离线密码重置

该操作只能在服务停止后执行。服务端构建产物必须存在；从发布目录根目录运行以下精确命令：

```bash
LLM_CHAT_DATA_DIR=/srv/llm-chat/data \
pnpm --filter @llm-chat/server auth:reset --confirm-reset-password
```

pnpm 会将该参数转发为 `node dist/auth-reset.js --confirm-reset-password`。不要写成
`auth:reset -- --confirm-reset-password`，额外的 `--` 会被转发，CLI 会拒绝执行。CLI 要求且只能
接受 `--confirm-reset-password` 一个参数，并取得数据目录实例锁；服务仍在运行时会失败。

成功时，CLI 会在事务中：

- 生成并保存新的 8 位数字密码；
- 撤销所有登录会话；
- 保留聊天、Agent、连接、工具和任务数据。

输出会列出新 `initialPassword` 和 `sessionsRevoked`。使用新密码登录后，可在“设置 > 安全”修改。

## 验证和 CI

CI 使用 Node.js 24、pnpm 11.7.0，并执行冻结安装。完整门禁顺序如下：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm audit --prod
pnpm test:deploy
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm test:e2e
```

`pnpm check` 包含类型检查、Web 预算检查、覆盖率测试和生产构建。`pnpm test:deploy` 会启动临时服务
并验证 Web 入口、`/healthz`、`/readyz`、build ID、单实例锁、运行中重置拒绝、SIGTERM 后生成/后台
任务回收，以及停服后的离线重置。

浏览器自动化项目是桌面 Chromium、Firefox、WebKit，以及 390x844 的移动 Chromium。每个项目都执行真实
密码登录。手动验收应使用当前版本的桌面 Safari、Chrome、Firefox，以及平台提供的移动 Safari、Chrome、
Firefox。非本机 HTTP 下普通网页可用，但 Service Worker、PWA 安装和离线缓存不作保证。

## 故障诊断

| 现象 | 检查和处理 |
| --- | --- |
| 启动报告 Web build artifact missing | 在当前不可变发布目录执行 `pnpm build`，确认 `apps/web/dist/index.html` 存在，并确认 `LLM_CHAT_SERVE_WEB=true` 时管理器使用的是该发布目录。若只运行 API，可显式设为 `false`。 |
| 报告数据目录被另一个 llm-chat 进程占用 | 检查 `served` 是否有旧副本、端口不同的副本或同一目录的别名进程。先停止并等待旧进程退出；不要删除锁文件绕过保护。 |
| 报告 disabled auth 只允许回环 | 检查 `LLM_CHAT_AUTH_MODE`、`LLM_CHAT_HOST` 和 `LLM_CHAT_PUBLIC_URL`。远程部署改为 `password`；不要把 disabled auth 暴露给网络。 |
| `/healthz` 为 200 但 `/readyz` 为 503 | 这是启动检查失败或关闭排空的预期信号。查看日志中的 `buildId`，确认 SQLite 可读写、Web 入口存在且进程没有收到停止信号；排空时等待进程退出，不要立刻重叠启动。 |
| 两个探针都无法连接 | 进程可能尚未监听、已退出或管理器已强制终止。检查管理器退出状态和启动日志，再确认端口、发布目录和运行时环境。 |
| 密码始终错误 | 检查是否使用当前数据目录首次启动时输出的密码。忘记密码时停服并执行离线密码重置。 |
