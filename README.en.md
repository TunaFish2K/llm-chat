# Chat

[简体中文](README.md)

Chat is a personal AI assistant for everyday conversations and lightweight tasks, including research, calculations, file processing, and background jobs. The interface supports Simplified Chinese and American English, follows your browser language by default, and lets you switch on the sign-in page or in Settings.

## Deployment

Install Node.js 24 or later and pnpm 11.7.0.

```bash
git clone https://github.com/TunaFish2K/llm-chat.git
cd llm-chat
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open `http://127.0.0.1:3000` and sign in with the eight-digit initial password from the first startup log. The first startup creates `config.json`. By default, the web app and API share port `3000` and accept local connections only.

To use an external configuration file, run `pnpm start --config /etc/llm-chat/config.json`; its parent directory must exist. Use HTTPS for remote access. See the [deployment manual](docs/DEPLOYMENT.md) (in Chinese) for listening addresses, data directories, browser tool dependencies, backups, and upgrades.

## Development

After installing dependencies, run:

```bash
pnpm dev
```

The web address is `http://127.0.0.1:5173`. The API address is `http://127.0.0.1:3000`. Vite proxies `/api` requests.

```bash
pnpm check
pnpm test:deploy
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm test:e2e
```

`pnpm check` runs type checks, the web test budget, builds, and coverage tests. Deployment smoke tests require build artifacts. End-to-end tests require the browsers above and use temporary data directories. Linux tests also require the [read-only shell sandbox dependencies](docs/DEPLOYMENT.md#可选的只读命令沙箱). See the [internationalization guide](docs/I18N.md) for language resources and integration.

## License

This project uses the [Unlicense](LICENSE). You may use, modify, and distribute it, including for commercial purposes. The software comes without warranty. Third-party dependencies, icons, and services retain their own licenses and terms.
