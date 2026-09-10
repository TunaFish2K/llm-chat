# Chat

[English](README.en.md)

## 部署

需要 Node.js 24 或更高版本，以及 pnpm 11.7.0。

1. 克隆仓库。

   ```bash
   git clone https://github.com/TunaFish2K/llm-chat.git
   ```

2. 进入项目目录。

   ```bash
   cd llm-chat
   ```

3. 安装依赖。

   ```bash
   pnpm install --frozen-lockfile
   ```

4. 构建应用。

   ```bash
   pnpm build
   ```

5. 启动服务。

   ```bash
   pnpm start
   ```

6. 打开 `http://127.0.0.1:3000`，使用首次启动时终端显示的八位初始密码登录。

首次启动会创建权限为 `0600` 的 `config.json`。默认只监听本机，网页与 API 共用 `3000` 端口。

| 配置项 | 默认值 | 用途 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 监听地址 |
| `port` | `3000` | 网页与 API 的 HTTP 端口 |
| `dataDir` | `./data` | 数据目录，相对路径以配置文件目录为准 |

需要独立配置文件时，执行 `pnpm start --config /etc/llm-chat/config.json`。该路径的父目录必须已存在。

远程部署时，按访问方式配置监听地址，并通过 HTTPS 保护密码和会话。PWA 安装和更新需要浏览器支持的安全上下文。

使用 `browser_fetch` 时，需要以服务运行用户安装 Firefox：

```bash
pnpm --filter @llm-chat/server exec playwright-core install firefox
```

更新服务端前，停止服务并等待进程退出。备份完整 `dataDir`、配置文件和进程管理配置。然后安装依赖、构建并重新启动。每个数据目录只允许一个服务进程。

备份包含密钥，必须限制访问。不要只复制 SQLite 文件，也不要混合新旧数据目录。数据库迁移向前执行，回滚需要匹配的发布版本与完整备份。

进程管理、反向代理、探针、旧配置升级和密码恢复见[部署运维手册](docs/DEPLOYMENT.md)。

## 开发

安装依赖后运行：

```bash
pnpm dev
```

开发时，网页地址为 `http://127.0.0.1:5173`，API 地址为 `http://127.0.0.1:3000`。Vite 将 `/api` 请求代理到服务端。开发环境使用两个端口，生产环境只使用配置中的 `port`。

`pnpm check` 依次执行类型检查、Web 测试预算、生产构建和覆盖率测试。其他检查可以单独运行：

```bash
pnpm test
pnpm audit --prod
pnpm test:deploy
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm test:e2e
```

运行 `pnpm test:deploy` 前需要执行 `pnpm build`。运行 `pnpm test:e2e` 前需要安装上面列出的浏览器。浏览器测试使用独立临时数据目录，不连接生产数据。

## 版权

本项目使用 [Unlicense](LICENSE)。你可以使用、复制、修改和分发本项目，也可以用于商业用途。软件按现状提供，不附带保证，完整条款见 LICENSE。

第三方依赖、图标和服务仍适用各自的许可证与条款。Unlicense 不改变这些条款。
