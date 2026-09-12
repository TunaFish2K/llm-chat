# 生产部署运维手册

本手册面向用户自己的 `served` 管理器。管理器负责启动、停止、重启、单副本约束和停止宽限期；可选的
HTTPS 反向代理负责证书、TLS 和对外入口。本仓库不生成 `served`、容器、systemd 或 nginx 配置，也不替
运维者选择具体的管理器或代理。

## 运行约束

- 每个配置文件指定的 `dataDir` 只能有一个 llm-chat 进程。不要让两个副本使用同一个目录，即使端口不同。
- 重启必须先停止旧进程并等待它退出，再启动新进程。锁会在应用完成关闭后释放；不要用删除锁文件的方式
  绕过占用检查。
- 发布代码和 `apps/web/dist` 是不可变发布产物。`dataDir` 是独立的、可写的持久化目录。
  Plugin、Skill 修订、任务日志和工具输出都在该目录内。
- 远程访问必须使用密码认证。纯 HTTP 可运行，但不能保护密码和会话免受网络窃听。

## 前置条件

准备以下内容：

1. Node.js 24 或更高版本，以及 pnpm 11.7.0。
2. 一个由服务账号拥有且可写的持久化数据目录，例如 `/srv/llm-chat/data`。目录权限应限制为服务账号；
   数据目录包含密钥和用户数据。
3. 一个独立的发布目录。发布完成后不要在该目录中改写源码或构建产物。
4. 可选的 DNS、TLS 证书和可信 HTTPS 代理。纯内网 HTTP 部署不要求这些组件。
5. 管理器的停止宽限期。它必须严格大于应用固定的 30 秒关闭期限，并且不能在该期限前
   发送 `SIGKILL`。

## 安装和构建

### 可选的浏览器工具

使用 `browser_fetch` 时，以服务运行用户安装 Firefox：

```bash
pnpm --filter @llm-chat/server exec playwright-core install firefox
```

### 可选的只读命令沙箱

`workspace_shell_readonly` 需要 Linux x86-64 或 ARM64、Bubblewrap 0.12.0 或更高版本，以及可用的非特权
用户命名空间和 seccomp。服务从启动时的 `PATH` 查找 `bwrap`，固定其绝对路径，并在启动时实际运行隔离
探测。缺少依赖或探测失败时，聊天服务仍可启动；只读命令在工具目录中标记为不可用，Agent 编辑页显示原因。
安装或升级 Bubblewrap 后重启服务以重新探测。容器部署还需允许创建所需命名空间。

先用发行版包管理器安装 Bubblewrap，并通过 `bwrap --version` 确认版本。旧于 0.12.0 的版本不满足本项目
的挂载路径隔离要求。Ubuntu 若因 AppArmor 拒绝用户命名空间，使用发行版提供、与 `bwrap` 安装路径匹配的
AppArmor 配置；不要通过关闭整台主机的限制来解决。CI 使用 `scripts/install-ci-bubblewrap.sh` 构建固定
版本，并为 CI 二进制配置路径限定的用户命名空间权限；该脚本仅用于临时 CI 主机。

沙箱只映射当前会话的项目目录、附件和系统程序、库及必要配置。项目目录为 `/workspace`，附件为
`/attachments`，`cwd` 相对于所选工作区。系统 `/usr/bin` 中的命令可直接调用，应用使用的 Node 可执行文件
也映射到沙箱；Python 等其他分析程序需安装到系统路径。用户目录中的运行时、配置文件和虚拟环境不会自动
暴露给沙箱。符号链接只能访问已映射的目标。工作目录内容为实时只读视图，不是文件快照。

网络和宿主机 IPC 被隔离，socket 创建被 seccomp 拒绝，工作目录中的 socket、FIFO 和设备文件会被替换为
沙箱中的只读空文件。`HOME` 指向临时目录，宿主机环境变量及登录 Shell 配置不会传入。
`/tmp` 上限为 64 MiB，每次调用独立，结束后清空。命令通过标准输出返回结果；宿主机中的项目和附件不允许写入。
命令的默认时限为 30 秒，上限为 120 秒，包含工作区检查；超时、取消或服务关闭时清理沙箱及其子进程。

Linux 上的 `pnpm test` 会运行真实沙箱测试，需要上述依赖及系统 Python 3；依赖缺失会导致测试失败。
其他平台仍测试不可用分支，但不宣称通过 Linux 隔离验证。普通 `workspace_shell` 不使用此沙箱，默认审批
策略保持独立；只读命令失败时不会自动调用普通 Shell。

### 构建发布产物

在新的发布目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` 先构建 Web，再构建服务端，并生成 `apps/web/dist/index.html`、`apps/server/dist/index.js`
和 `apps/server/dist/auth-reset.js`。服务始终提供 Web 页面，缺少 Web 入口时不会启动。
完成验证后，将整个发布目录作为不可变代码版本交给管理器；不要把可写数据目录放进代码发布目录。

质量门禁见[验证和 CI](#验证和-ci)。`pnpm test:deploy` 需要已经构建的服务端产物；新检出目录可先执行
`pnpm check` 或上面的 `pnpm build`。

## 启动配置

服务的常规运行配置只读取 JSON 文件，不读取旧的通用 `LLM_CHAT_*` 运行时环境变量。从发布目录根执行
`pnpm start` 时，默认使用项目根目录的 `config.json`。如果文件不存在，服务会以 `0600` 权限
排他创建完整默认配置，然后继续启动；已有但无效的配置不会被覆盖。

```json
{
  "host": "0.0.0.0",
  "port": 3000,
  "dataDir": "/srv/llm-chat/data"
}
```

也可以把配置放在发布目录外，并从发布目录根启动：

```bash
pnpm start --config /etc/llm-chat/config.json
```

显式配置路径的父目录必须已经存在；缺失文件会在该目录内自动生成。`dataDir` 的相对路径按配置文件
所在目录解析。浏览器可以通过 localhost、回环 IP、内网 IP 或反向代理域名访问，无需声明公开地址。
服务忽略代理转发的协议和客户端 IP。反向代理后的请求按直接连接设置会话 Cookie；通过同一代理的客户端共用该代理地址的登录限流。

运行时配置的默认值和解析规则如下：

| 配置项 | 默认值 | 规则 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 非空单行字符串 |
| `port` | `3000` | 1 到 65535 的整数 |
| `dataDir` | `./data` | 非空路径；相对配置文件解析；与其他进程共享会触发实例锁 |

服务固定启用密码认证，所有环境均须登录；开发和测试没有免认证开关。`pnpm dev` 先准备 Web
产物，再启动前后端监听进程。应用始终提供 Web 页面，且始终在启动和就绪检查中验证 Web 入口。

升级旧配置时，删除 `authMode`、`trustProxy`、`serveWeb`、`shutdownTimeoutMs` 和 `buildId`。
解析器会列出已移除字段并拒绝启动，不会静默忽略或自动改写配置。修改前备份原配置；保留原来的
`host`、`port`、`dataDir`，密码和会话数据无需迁移。

配置文件是明文 JSON，应用不加密也不改写已有文件。当前运行配置不包含模型 API Key；这些业务密钥仍
保存在 SQLite。仍应限制配置文件所有者和权限，并将外置配置与 `dataDir` 分别备份。

## 锁和副本

读取并验证配置后，进程为规范化后的 `dataDir` 取得实例锁，然后才创建 `Store` 和 SQLite。锁使用数据目录
中的 `.llm-chat-instance` 标记文件；同一目录的绝对路径、相对路径或符号链接别名都不能绕过它。占用
时启动会失败并报告数据目录已被另一个 llm-chat 进程占用。

因此，`served` 必须配置一个副本，并将滚动更新实现为停止旧进程、确认其退出、启动新进程的顺序。不能
让新旧进程重叠，也不能用不同端口规避锁。离线认证重置 CLI 也取得同一把锁，所以必须遵守相同的停服
要求。

## HTTP 边界和探针

服务可以直接监听内网地址，也可以位于反向代理之后。浏览器写请求通过专用请求头和 Fetch Metadata
校验抵御跨站请求，不依赖固定公开地址。Web 前端和 API 仍应位于同一 origin；本服务不提供跨域 API。
密码和会话 Cookie 在纯 HTTP 中可能被截获；需要传输安全时应使用 HTTPS 代理。

管理器应使用以下端点：

```bash
curl -sS -i http://127.0.0.1:3000/healthz
curl -sS -i http://127.0.0.1:3000/readyz
```

- `/healthz` 是存活探针。服务开始监听后返回 HTTP `200`、`ok: true` 和当前 `buildId`，不执行 SQLite
  查询。关闭排空时它仍可能返回 `200`，所以不要用它决定是否继续接收流量。
- `/readyz` 是就绪和流量探针。启动完成后，它检查 SQLite 的 `SELECT 1`，并检查
  `apps/web/dist/index.html`。通过时返回 HTTP `200`、`ok: true` 和 `buildId`；启动未完成、检查失败
  或关闭排空时返回 HTTP `503`、`ok: false` 和 `buildId`。

关闭收到 `SIGTERM` 后会立即撤回 readiness。应用先中止并等待活动生成，再关闭后台任务、Plugin/MCP
资源、Fastify 和 SQLite，最后释放实例锁。后台任务先向进程组发送 `SIGTERM`，单个任务最多等待 2 秒；
仍未退出时发送 `SIGKILL`。整个应用关闭的上限固定为 30 秒；清理完成即退出，超时以退出码 1 强制退出。
管理器宽限期必须严格超过此值，并应使用 `/readyz` 先摘流量。

## 更新和回滚

更新时先在新的发布目录安装依赖并构建。构建将版本标识直接写入服务端代码，同时输出
`apps/server/dist/build-info.json` 供部署核对；运行时不读取配置或环境变量覆盖标识。

构建标识优先取 Git 提交号前 12 位。参与构建的源码存在未提交改动时追加 `-dirty-<内容哈希>`。
`git archive` 通过 `BUILD_REVISION` 的 `export-subst` 携带提交号，没有 `.git` 也能识别版本；没有
Git 和归档提交信息时使用 `source-<内容哈希>`。直接运行源码的开发模式显示 `development`。

然后按停服顺序切换管理器：

1. 停止旧进程，等待旧进程退出并确认旧数据目录不再被占用。
2. 启动新发布目录中的 `pnpm start --config <path>`，使用同一份外置配置或等效的 `dataDir`。
3. 轮询 `/readyz`，确认 HTTP `200` 且响应中的 `buildId` 与新制品的 `build-info.json` 一致；再把流量切换到新进程。

回滚使用同样的停服和单副本顺序，选择以前的不可变发布目录并保留同一个数据目录。启动前确认该版本
支持当前数据库架构；数据库迁移在启动时向前执行，旧版本可能拒绝比它更新的数据库版本，不要假设可以
自动降级。若需要回到迁移前状态，停止服务并恢复更新前保存的完整数据目录备份。

### 模型协议升级（v42）

本版本将 SQLite 升级到 v42，为模型增加可空的手动协议和自动识别协议。旧模型保留 ID、配置和历史，
默认继续使用自动模式。已有 OpenCode Go 的 Grok 4.6 会直接使用 Responses，无需删除或重建连接。
部署前停服并备份完整数据目录；回滚到 v41 服务时恢复迁移前备份。协议优先级和目录刷新规则见
[模型协议](MODEL-PROTOCOLS.md)。

### 通用原生档位升级（v43）

SQLite v43 增加模型的手动和自动识别档位列表，回填确切匹配的已有目录数据。历史请求和旧 `none`
语义保留。旧客户端修改新格式的推理设置时需要刷新页面。未知档位的模型只提供“提供商默认”，需要时
在模型设置中手动填写原生值。部署前停服并备份完整数据目录；回滚到 v42 服务需恢复迁移前备份。

### 从含 Codex 专用集成的版本升级

Codex 专用面板、工具和 `/api/codex/*` 接口已移除。平台不再读取 `LLM_CHAT_CODEX_BIN`、
`LLM_CHAT_CODEX_SOCKET` 和 `LLM_CHAT_CODEX_PROFILE`，也不再自动连接或恢复 Codex 会话。
升级前确认没有仍需处理的 Codex 任务，再按上述停服、备份和切换流程部署。刷新旧标签页以载入新界面。

旧 Codex 数据表与记录保留。平台自带的 `coding-supervisor` 会停用并从可选目录中隐藏；
旧安装记录和 Skill 修订保留，重新加载不能恢复它。用户安装的 Skill、主机上的 Codex 安装及其数据不受影响。
通用后台任务与交互式命令继续可用。定位与兼容边界见 [ADR-007](ADR-007-conversation-and-lightweight-tasks.md)。

## 停服备份和恢复

`dataDir` 指向的目录是唯一的运行数据备份/恢复单元，不能只复制 `llm-chat.sqlite`。除了 SQLite 及其
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

4. 使用指向同一 `dataDir` 的配置启动服务，检查 `/healthz` 和 `/readyz`，再恢复流量。

不要在服务运行时用普通文件复制替换 SQLite，也不要只恢复数据库而遗漏修订、任务日志或工具输出。

若管理器的停止宽限期不超过 30 秒，先向应用 PID 发送 `SIGTERM` 并等待其自行退出，再执行管理器的停用和切换操作。不要让短宽限期提前强制终止清理。

### 保留数据的交互版本回退

此前的交互回退恢复了 `ae9e249` 的界面与交互，并兼容 v40 数据库。该回退版本新建 v39 数据库，
打开已有 v40 数据库时保留其版本、消息、会话和提交收据。

当前国际化版本升级到 v41，为错误增加可空的语言元数据；保留 v39/v40 的历史内容和已有提交收据。
部署前备份完整数据目录。回滚到交互回退版本时，需恢复对应的迁移前备份。详情见[国际化说明](I18N.md)。

部署时使用包含兼容处理的新发布包，不要直接启动原始 `ae9e249` 制品。停服后先备份当前完整数据目录，
再使用原数据目录启动新发布包，无需恢复更新前的 v39 备份。尚未刷新的标签页携带 `clientRequestId`
提交时会收到 `409 client_update_required`；刷新页面后使用恢复的交互继续操作。

## 离线密码重置

该操作只能在服务停止后执行。服务端构建产物必须存在；从发布目录根目录运行以下精确命令：

```bash
pnpm --filter @llm-chat/server auth:reset \
  --config /etc/llm-chat/config.json \
  --confirm-reset-password
```

不要写成 `auth:reset -- --config ...`，额外的 `--` 会被转发，CLI 会拒绝执行。CLI 只接受
`--config <path>` 和 `--confirm-reset-password`。它不会自动生成缺失配置；读取配置中的
`dataDir` 后取得数据目录实例锁，服务仍在运行时会失败。

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

启用日志时，服务每 60 秒输出一条 `Runtime memory`，记录 `rss`、`heapTotal`、`heapUsed`、`external`、
`arrayBuffers`（单位为字节）、`activeGenerations`、`activeSse` 和 `sseBufferedBytes`。
结合负载消退后的多次采样判断是否持续增长；单次 RSS 上升不能证明泄漏。

`SSE connection closed` 记录断开原因：`client-disconnected` 为客户端断开，`generation-ended` 为生成结束，
`shutdown` 为服务关闭，`write-error` 为写入失败。`queue-overflow` 表示待发送队列超过 2 MiB，
`drain-timeout` 表示写缓冲连续 15 秒未排空。单个大快照允许直接写入，后续积压仍受队列上限约束；
客户端重连后重新读取快照。排查断连时，同时核对代理或隧道日志与进程退出记录。

浏览器历史仍保存在原 IndexedDB 数据库。升级后按记录补齐大小和图片索引，不需要清除历史或迁移数据库版本。

| 现象 | 检查和处理 |
| --- | --- |
| 启动报告 Web build artifact missing | 在当前不可变发布目录执行 `pnpm build`，确认 `apps/web/dist/index.html` 存在，并确认管理器使用的是该发布目录。 |
| 报告数据目录被另一个 llm-chat 进程占用 | 检查 `served` 是否有旧副本、端口不同的副本或同一目录的别名进程。先停止并等待旧进程退出；不要删除锁文件绕过保护。 |
| 配置文件无法生成 | 确认显式路径的父目录已经存在并允许服务账号写入；服务不会递归创建配置目录。 |
| 配置文件不是有效 JSON 或包含未知字段 | 修正原文件；服务不会覆盖或“修复”已有配置。可以对照 `config.example.json`。 |
| `/healthz` 为 200 但 `/readyz` 为 503 | 这是启动检查失败或关闭排空的预期信号。查看日志中的 `buildId`，确认 SQLite 可读写、Web 入口存在且进程没有收到停止信号；排空时等待进程退出，不要立刻重叠启动。 |
| 两个探针都无法连接 | 进程可能尚未监听、已退出或管理器已强制终止。检查管理器退出状态和启动日志，再确认端口、发布目录和运行时环境。 |
| 密码始终错误 | 检查是否使用当前数据目录首次启动时输出的密码。忘记密码时停服并执行离线密码重置。 |
