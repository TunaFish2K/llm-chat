# Chat

[English](README.en.md)

Chat 是用于日常对话和轻任务的个人 AI 助手，支持查询、计算、文件处理和后台任务。界面支持简体中文和美式英语，默认跟随浏览器语言，也可在登录页或设置中切换。

## 部署

需要 Node.js 24 或更高版本和 pnpm 11.7.0。

```bash
git clone https://github.com/TunaFish2K/llm-chat.git
cd llm-chat
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

打开 `http://127.0.0.1:3000`，使用首次启动日志中的八位初始密码登录。首次启动会创建 `config.json`；默认只监听本机，网页与 API 共用端口 `3000`。

使用独立配置文件：`pnpm start --config /etc/llm-chat/config.json`，其父目录须已存在。远程访问请配置 HTTPS。监听地址、数据目录、浏览器工具依赖、备份和升级步骤见[部署运维手册](docs/DEPLOYMENT.md)。

## 开发

安装依赖后运行：

```bash
pnpm dev
```

网页地址为 `http://127.0.0.1:5173`，API 地址为 `http://127.0.0.1:3000`。Vite 会代理 `/api` 请求。

```bash
pnpm check
pnpm test:deploy
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm test:e2e
```

`pnpm check` 包含类型检查、Web 测试预算、构建和覆盖率测试。部署冒烟测试需要构建产物；端到端测试需要上述浏览器，并使用独立临时数据目录。Linux 测试还需安装[只读命令沙箱依赖](docs/DEPLOYMENT.md#可选的只读命令沙箱)。语言资源与接入方法见[国际化说明](docs/I18N.md)。

## 版权

本项目使用 [Unlicense](LICENSE)，允许使用、修改和分发，包括商业用途；软件按现状提供，不附带保证。第三方依赖、图标和服务适用各自的许可证与条款。
