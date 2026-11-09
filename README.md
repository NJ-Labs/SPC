<p align="center">
  <img src="public/images/full_logo.png" alt="SPC Analysis Tool" width="320" />
</p>

# SPC Analysis Tool

A modern, client‑side Statistical Process Control (SPC) web application for exploring data, generating control charts, and detecting special‑cause variation using Nelson or Western Electric rules. Built with React + TypeScript, Chart.js, and Vite.

## Features

- Data import: upload CSV, XLS, or XLSX files (multi‑sheet Excel supported).
- Spreadsheet‑like editor: sort, edit, copy/paste, resize columns, and manage multiple sheets.
- Control charts: I-MR, P, NP, C, U, X-bar R, X-bar S, and EWMA, plus Histogram and Scatter Plot.
- Rule detection: choose the eight Nelson tests or four Western Electric rules, inspect signal windows and affected points, and monitor MR/R/S variation alongside the main chart.
- On‑chart overlays: center line, ±1σ/±2σ/±3σ bands, UCL/LCL, configurable titles and labels.
- Capability: Cp/Cpk/Cpl/Cpu, Pp/Ppk/Ppl/Ppu, and target-adjusted Cpm with separate within/overall sigma estimates and readiness reasons. Enter specification limits from your process requirements.
- Export: save processed data to CSV or Excel from the browser.
- Responsive UI: Tailwind‑styled panels, control sidebar, and helpful chart guidance.
- AI guidance: Ask the built-in assistant to review uploaded data and recommend SPC chart types with context-aware advice.
- Deployable anywhere: Docker image and Helm chart for Kubernetes with best‑practice manifests.

## Screenshots

<p>
  <img src="public/images/README/SPC_full_page-data_input.png" alt="Data input and spreadsheet preview" width="800" />
</p>

<p>
  <img src="public/images/README/Analysis.png" alt="SPC analysis and chart visualization" width="800" />
</p>

<p>
  <img src="public/images/README/Chart_Control.png" alt="Chart controls and configuration" width="800" />
</p>

## Quick Start (Local)

- Prerequisites: Node.js 24 LTS (22.13+ or 26+ also supported), npm, and [uv](https://docs.astral.sh/uv/getting-started/installation/).
- Install deps: `npm install`; use `npm ci` for the exact locked tree. uv manages Python 3.12 and the gateway dependencies.
- Run dev: `npm run dev` starts the gateway, waits for it, then starts Vite. Open the local URL shown; Ctrl+C stops both services.
- Build: `npm run build` (outputs static assets to `dist/`).

## AI Chart Assistant Configuration

Configure the upstream model service in the root `.env` (copy `.env.example` if needed):

```dotenv
AI_API_KEY=your-api-key
AI_API_URL=https://api.openai.com/v1
AI_MODEL=your-model-id
```

`AI_API_URL` is the upstream OpenAI-compatible server, not the local SPC gateway. A server URL, `/v1` base, or full `/v1/chat/completions` URL works; custom path prefixes are retained. The model ID needs no provider prefix. Set `AI_PROVIDER` only for a different LiteLLM provider. See `.env.example` for optional advanced settings. Legacy `AI_API_BASE`, `DSPY_*`, and `VITE_AI_*` settings remain supported; canonical settings win when both are set.

If an older `.env` points `AI_API_URL` at the local gateway and uses `AI_API_BASE` for the upstream, move the upstream URL to `AI_API_URL`. The gateway rejects a URL pointing back to itself.

Start the gateway and frontend together from the project root:

```powershell
npm run dev
```

The first start may download Python and its locked packages. Install uv once on Windows with `winget install --id astral-sh.uv -e`, then reopen the terminal. `npm run dev:web` and `npm run dev:gateway` are available when separate processes are needed.

Vite proxies `/v1` and `/config/runtime-config.js` to the gateway on port 8001 (or `AI_GATEWAY_PORT`). The gateway supplies the browser configuration and keeps the upstream key server-side. The gateway token is sent to the browser and is not a private upstream credential. Restart `npm run dev` after changing the gateway port.

For explicit direct-browser connections, set `VITE_AI_API_URL`, `VITE_AI_API_KEY`, and `VITE_AI_MODEL`; these values are visible to browser users and included in the frontend bundle. Alternatively supply a browser runtime config. Runtime values take precedence over `VITE_AI_*`.

Once configured, click **Ask AI** in the Data Input panel to review the dataset and ask follow-up questions.

### Analysis and assistant workflow

1. Select the worksheet, measurement columns, chart type, and any subgroup size or denominator column. For X-bar charts, multiple Y columns form one subgroup per row; one Y column forms sequential complete subgroups.
2. Choose **Nelson** or **Western Electric** in the chart controls. Missing values break run-rule windows; the charts, rule panel, capability assessment, and assistant share the same analysis results.
3. Enter LSL, USL, and an optional target to assess capability. Cp/Cpk use within-process variation; Pp/Ppk use overall sample variation. On X-bar charts, the plotted sigma is the standard error of the subgroup mean. Preliminary results include reasons such as instability, limited data, skew, or autocorrelation.
4. Open **Ask AI** for explanations and follow-ups. Enable **Agent Mode** to let the assistant configure the chart. Each agent reply shows the actual before/after changes, unchanged fields, and rejected settings. Replies based on a changed dataset are rejected.
5. Ask for an interactive explanation, such as “show how sigma zones trigger the Western Electric rules.” Complete HTML blocks appear inside isolated frames with source and download controls. The written explanation remains available if a block cannot run.

The gateway gives smaller models compact dataset profiles, deterministic analysis results, validated control tools, and focused SPC knowledge. The model explains results; it does not calculate capability indices or invent specification limits. Offline tests cover malformed model output and tool failures without requiring a live model.

### Local checks

Run `npm test`, `npm run typecheck`, and `npm run build`. `npm run test:dev` verifies real startup and browser-safe runtime configuration with dummy credentials. Gateway tests use the existing Python project: `uv run --project services/dspy-gateway python -B -m unittest discover -s services/dspy-gateway -p "test*.py"`.

## Docker

- Build combined image: `docker build -t spc-web .`
- Run combined container: `docker run --rm -p 8080:8080 spc-web`
- Open: http://localhost:8080

The root image now bundles both SPC-web and the DSPy gateway into a single container. The browser calls the embedded gateway on the same origin at `/v1/chat/completions`.

To run SPC-web and the embedded DSPy gateway together for local development:

```bash
cp .env.example .env
# Set AI_API_KEY, AI_API_URL, and AI_MODEL in .env
docker compose up --build
```

SPC-web is served on `http://localhost:8080` and the embedded gateway shares the same container and host port.
The gateway serves browser runtime configuration dynamically, including any configured gateway token.
The combined image already includes the Bluecoat CA bundle from `deploy/docker/certs/bluecoat-ca-bundle.pem`, so local runs and default cluster deployments do not need an extra CA mount or secret.
If your Docker environment needs custom Python package index settings for the gateway image build, set `DSPY_PIP_INDEX_URL`, `DSPY_PIP_EXTRA_INDEX_URL`, or `DSPY_PIP_TRUSTED_HOST` in `.env` before running Compose.

The image is a multi‑stage build (Node for the SPC-web bundle → Python runtime for the embedded DSPy gateway and static asset serving).

For local Python workflows in this repo, use the existing `services/dspy-gateway` `uv` project rather than creating a separate root virtualenv.

## Kubernetes (Helm)

This repo ships with a Helm chart under `deploy/helm/spc-analysis-tool` for production‑ready deployment:

- Templates include `Deployment`, `Service`, `Ingress`, `HPA`, `PDB`, `NetworkPolicy`, `ServiceMonitor`, `ResourceQuota`, `LimitRange`, `ServiceAccount`, and optional `ExternalSecret`/`Secret`/`ConfigMap`.
- Default values: `deploy/helm/spc-analysis-tool/values.yaml` (see also `prod-values.yaml`).

Install/upgrade:

```
helm upgrade --install spc-analysis-tool deploy/helm/spc-analysis-tool \
  -n spc --create-namespace \
  -f deploy/helm/spc-analysis-tool/values.yaml
```

Tailor `values.yaml` for ingress host, resources, and any config map entries. For hardened clusters, set `securityContext`, `podSecurityContext`, and ingress annotations as needed.

In gateway mode, Helm now generates `/config/runtime-config.js` from the gateway values automatically. Set the upstream endpoint, provider, and model once under `gateway.env`, and set the upstream secret key once under `gateway.secretEnv.data.AI_API_KEY`.

## Tech Stack

- React 18 + TypeScript + Vite
- Chart.js + react-chartjs-2 (+ annotation plugin)
- Tailwind CSS
- PapaParse (CSV) and xlsx (Excel)
- jStat (stats utilities)
- Docker + Nginx; Helm for Kubernetes

## Project Structure

- App UI: `src/` (components under `components/analysis`, `components/charts`, `components/layout`, `components/upload`)
- Data processing: `src/utils/spcCalculations.ts`, `src/utils/westernElectricRules.ts`, `src/utils/fileUtils.ts`
- Types: `src/types/`
- Static assets: `public/`
- Docker runtime: `Dockerfile`
- Kubernetes chart: `deploy/helm/spc-analysis-tool/`

## Notes

- Data stays in the browser; no server is required to analyze files.
- Choose Nelson or Western Electric rules to highlight potential special-cause variation; validate results with your process context.

## License

This project is provided as‑is. Add your preferred license here if applicable.
