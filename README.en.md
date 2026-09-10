# Chat

[中文](README.md)

## Deployment

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

The first startup creates `config.json` with mode `0600`. By default, the server accepts local connections only. The web app and API share port `3000`.

| Setting | Default | Purpose |
| --- | --- | --- |
| `host` | `127.0.0.1` | Listening address |
| `port` | `3000` | HTTP port for the web app and API |
| `dataDir` | `./data` | Data directory, relative to the configuration file's directory |

Use `pnpm start --config /etc/llm-chat/config.json` for an external configuration file. Its parent directory must exist.

For remote access, set the listening address to suit your deployment and use HTTPS to protect passwords and sessions. PWA installation and updates require a browser-supported secure context.

To use `browser_fetch`, install Firefox as the service user:

```bash
pnpm --filter @llm-chat/server exec playwright-core install firefox
```

Before updating the server, stop it and wait for the process to exit. Back up the complete `dataDir`, configuration file, and process manager configuration. Then install dependencies, build, and restart. Only one server process can use a data directory.

Backups contain credentials, so restrict access. Do not copy only the SQLite files or combine old and new data directories. Database migrations move forward. Rollback requires a compatible release and a complete backup.

See the [deployment manual](docs/DEPLOYMENT.md) for process management, reverse proxies, probes, configuration upgrades, and password recovery. The manual is in Chinese.

## Development

After installing dependencies, run:

```bash
pnpm dev
```

The development web address is `http://127.0.0.1:5173`. The API address is `http://127.0.0.1:3000`. Vite proxies `/api` requests to the server. Development uses two ports. Production uses only the configured `port`.

`pnpm check` runs type checks, the web test budget, production builds, and coverage tests, in that order. You can run other checks separately:

```bash
pnpm test
pnpm audit --prod
pnpm test:deploy
pnpm exec playwright install --with-deps chromium firefox webkit
pnpm test:e2e
```

Run `pnpm build` before `pnpm test:deploy`. Install the browsers listed above before running `pnpm test:e2e`. Browser tests use temporary data directories and do not access production data.

## License

This project uses the [Unlicense](LICENSE). You may use, copy, modify, and distribute it, including for commercial purposes. The software is provided as is, without warranty. See LICENSE for the full terms.

Third-party dependencies, icons, and services retain their own licenses and terms. The Unlicense does not replace those terms.
