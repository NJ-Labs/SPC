# SPC setup

Use Node.js **24 LTS** (22.13+ and 26+ are also supported), npm, and [uv](https://docs.astral.sh/uv/getting-started/installation/). uv downloads Python 3.12 when needed. The project uses `package-lock.json` and npm for local development and Docker builds.

## Quick start on Windows

Install Node.js from https://nodejs.org/ and install uv once:

```powershell
winget install --id astral-sh.uv -e
```

Reopen PowerShell so the updated PATH is available, then:

```powershell
cd D:\Projects\SPC
npm install
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
```

Set these three values in `.env`:

```dotenv
AI_API_KEY=your-key
AI_API_URL=https://your-model-server/v1
AI_MODEL=your-model-id
```

`AI_API_URL` is the upstream model server, not the SPC gateway. A server URL, `/v1` base, or full `/v1/chat/completions` URL works. Use the model ID exactly as the server lists it. Additional parameters in `.env.example` are optional. The project-root `.env` takes priority over an older `services/dspy-gateway/.env`; use `SPC_ENV_FILE` only when intentionally selecting a different file.

Start the app and gateway together:

```powershell
npm run dev
```

The command installs the locked Python packages if needed, starts the gateway on `127.0.0.1:8001`, waits for it, and starts Vite on `http://localhost:5173`. **Ctrl+C stops both services.** An existing SPC gateway is reused and remains running when the frontend stops.

The upstream key stays in the gateway; the browser receives same-origin `/` as its API URL and a separate gateway token. Missing AI settings do not prevent local SPC calculations. Configure all three values to use chat.

For a reproducible full setup, run `./setup.ps1` instead. It runs `npm ci`, `uv sync --frozen`, typechecks, tests, and the build. `-Force` refreshes downloads without changing the lockfiles. `-Docker` also builds a local container.

## macOS / Linux

Install Node.js 24 LTS. Install uv with `brew install uv` on macOS or follow uv's Linux installation instructions linked above. Then use the same `npm install` and `npm run dev` commands. `bash setup.sh` performs the full setup; `--force` and `--docker` match the PowerShell options.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Gateway and frontend together, with hot reload |
| `npm run dev:web` | Frontend only; requires an existing gateway for chat |
| `npm run dev:gateway` | Gateway only, for troubleshooting |
| `npm run dev -- --port 3000` | Use another frontend port |
| `npm test` | Frontend unit and component tests |
| `npm run test:gateway` | Offline Python gateway tests |
| `npm run test:dev` | Real startup/proxy regression, with dummy credentials |
| `npm run typecheck` | TypeScript checks |
| `npm run build` | Production frontend build |
| `npm run preview` | Preview the frontend build; start a gateway separately for chat |
| `npm run lint` | ESLint |
| `npm audit` | Check installed dependencies against current advisories |

Tailwind **v4** runs through `@tailwindcss/vite`; `src/index.css` contains its theme and compatibility styles. No legacy Tailwind PostCSS configuration is needed. Browser support is Chrome 111+, Safari 16.4+, and Firefox 128+.

## Troubleshooting

**`ECONNREFUSED 127.0.0.1:8001`**: use `npm run dev` to start both services. If running `dev:web`, start `dev:gateway` separately. Review any Python error shown before Vite starts. Set optional `AI_GATEWAY_PORT` in `.env` if 8001 is occupied, and restart the command; the Vite and gateway ports must differ.

**`uv` is not found**: install it and reopen the terminal. `npm install` installs frontend packages; uv manages the gateway's Python packages. `npm run dev:web` is available for frontend-only work.

**Unsupported Node version**: use Node.js 24 LTS, 22.13+, or 26+. Older Node versions cannot run the updated Vite/Vitest toolchain; `.npmrc` rejects incompatible installations early.

**Install scripts**: `package.json` explicitly approves the locked esbuild installer needed by Vite. Check new script warnings with `npm install-scripts ls` on npm 11. Review each newly introduced installer before approving it. Do not disable npm's script checks globally.

**Windows `EPERM` / file in use**: stop all development servers and test watchers before reinstalling. Native Vite/Tailwind libraries remain locked while a Node process uses them; administrator access is not the normal fix.

**Dependency repair**: use `npm ci` to restore the committed dependency tree. Avoid `npm audit fix --force`; major upgrades require compatibility checks. SheetJS is pinned to the patched official tarball in vendor/ because the xlsx package on the npm registry is an older release. The local copy avoids extra CDN access and corporate certificate failures during installation; its source, checksum, and license are recorded in vendor/README.md.

**Invalid or expired API key**: the alert and chat reply identify this explicitly. Replace AI_API_KEY in the root .env file and retry; the gateway reloads the value on the next request. Model-permission failures are shown separately.

**Corporate network / certificate failures**: Windows system-trusted certificates are included automatically, with TLS verification enabled. The repository/container corporate CA bundle is also detected automatically. follow the optional CA and Python index settings in `.env.example` and `services/dspy-gateway/README.md`. Keep TLS verification enabled. uv installation failures are shown directly in the startup terminal.

**Browserslist data warning**: use `npx update-browserslist-db@latest` and review the lockfile change, then run the build. This is distinct from the gateway connection error.

## Containers

```powershell
docker compose up --build
```

The combined image serves the frontend and gateway on `http://localhost:8080`. Build settings are in `Dockerfile` and `docker-compose.yml`; gateway setup is documented in [services/dspy-gateway/README.md](services/dspy-gateway/README.md). Helm deployment guidance remains in [README.md](README.md).

For MMEMS cluster deployment, follow the `mmems-cluster-images` policy: push a unique image tag to Artifactory first and use `nave-pull-secret`; never import images into nodes manually.
