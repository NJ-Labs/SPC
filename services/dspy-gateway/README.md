# DSPy Gateway (SPC Assistant)

A small FastAPI service that wraps DSPy and exposes the endpoints used by the SPA:

- `POST /v1/chat/completions` (OpenAI-compatible; plain chat, or LiteLLM passthrough when `tools` are sent)
- `POST /v1/agent/turn` (Agent Mode: bounded DSPy ReAct over the SPC tools)
- `GET /health`
- `GET /health/ready`

## Why

This gateway improves answer consistency by:

- forcing deterministic generation defaults (`temperature=0`)
- centralizing style constraints (short, bullet-based responses)
- using a structured DSPy signature instead of ad-hoc prompt concatenation

## Agent Mode design (small-model friendly)

- Numbers come from the browser's SPC engine, never from the model. The request's `processed` summary is turned into a
  compact text "evidence" block (settings, headers, profile, limits, rule signals per rule set, MR/R/S signals, capability).
- Four tools: `list-tools`, `read_controls`, `read_spc_diagnostics`, `update_controls`. Argument schemas shown to the model
  are permissive; Python normalizes paraphrases (`"X-bar R"`, `"true"`, header case) and validates everything.
- `update_controls` rejects what does not fit the data (non-numeric Y, P/NP/C/U vs column profile, bad denominators,
  spec-limit edits) with a reason. `controlPatch` holds only real changes plus additive `changes`, `rejected`, `warnings`.
- `BoundedReAct` recovers once from a malformed step, accepts tool-name paraphrases, stops repeated calls, keeps tool
  errors short, and honours a wall-clock deadline. If the final answer ignores the format, the raw text is used;
  if nothing usable comes back, a deterministic answer with app evidence is returned (`status: "fallback"`). Non-parser model failures propagate as upstream errors.
- Changing analytical settings invalidates the previous limits, rules, and capability until the browser recalculates them. The gateway withholds stale tables and numerical claims. Cosmetic changes keep existing evidence valid.
- The latest request is preserved in full, including a reduced-context retry. Requests over `DSPY_MAX_REQUEST_CHARS` (default 16000) return HTTP 413 before any settings change.
- Output guards: unverified "I changed..." claims and numerical claims absent from app/user data are flagged
  (`warnings`, `grounding`); evidence tables are appended when the user asks for capability, rules, limits, or diagnostics.
- One self-contained ` ```html ` block is allowed per answer; blocks with external URLs, network calls, or parent/app access
  are removed. When the user asks for an interactive explanation and none survives, `spc_visuals.py` supplies a
  deterministic capability what-if or rule explorer for those topics. Unsupported requests remain text rather than receiving an unrelated widget.
- Additive response fields: `status`, `intent`, `warnings`, `evidence`, `grounding`, `stopReason`.

Tuning (all optional, also read from the root `.env`):

| Variable | Default | Meaning |
|---|---|---|
| `DSPY_AGENT_MAX_ITERS` | 5 | ReAct steps per turn (1-8) |
| `DSPY_AGENT_DEADLINE_SECONDS` | 90 | Wall-clock budget for tool steps |
| `DSPY_AGENT_MAX_TOKENS` | 1024 | Completion budget for agent turns |
| `DSPY_HTML_MAX_TOKENS` | 3000 | Completion budget when an interactive explanation is requested |
| `DSPY_JSON_ADAPTER_FALLBACK` | false | Retry malformed replies with DSPy's JSON adapter (extra call; some servers reject `response_format`) |
| `SPC_KNOWLEDGE_DIR` | auto | Folder of SPC Markdown knowledge; defaults to `knowledge/` beside `main.py` or the repo's `docs/knowledge` |

Built-in core SPC rules are always included, so the agent stays grounded even when `docs/knowledge` is not shipped.
`GET /health/ready` reports `knowledge_docs` so a missing knowledge folder is visible.

## Tests

Offline (no model or network needed):

```bash
uv run --frozen python -B -m unittest
```

`test_spc_agent_harness.py` replays scripted model replies (including malformed ones) through the real ReAct loop. `test_env_integration.py` uses a local stub server to verify the three-value setup, exact model IDs, key isolation, readiness, and reloads. No live model is needed.

## Run locally

```bash
uv sync --frozen
# Edit project root .env and set AI_API_URL / AI_API_KEY / AI_MODEL
# Only these three values are required: AI_API_KEY, AI_API_URL, AI_MODEL.
# AI_API_URL accepts a server, /v1 base, or full /v1/chat/completions endpoint.
# Raw model IDs need no provider prefix or AI_PROVIDER for OpenAI-compatible servers.
uv run main.py
```

The service runs on `http://localhost:8001` by default.

## Front-end wiring

Set runtime config (`/config/runtime-config.js`) and point AI to the gateway:

```js
window.APP_CONFIG = {
	ENV: "local",
	FEATURES: {},
	AI: {
		API_URL: "",
		API_KEY: "",
		MODEL: "",
	},
};
```

## Notes

- The gateway enforces `LITELLM_LOCAL_MODEL_COST_MAP=true` at startup, so LiteLLM uses bundled local metadata without remote fetch.
- The Docker image bundles the Bluecoat CA from `certs/bluecoat-ca-bundle.pem`, so default container runs do not need an extra CA mount or CA secret.
- `GET /health/ready` validates model/key config and basic upstream host reachability for `AI_API_BASE`.
- Changes to root `.env` are reloaded automatically on the next request (no gateway restart required).
- For OpenAI-compatible self-hosted endpoints (for example vLLM), set `AI_API_BASE` to your server base (typically ending with `/v1`).
- `AI_API_URL` selects the upstream server and defaults to OpenAI-compatible routing. Use `AI_PROVIDER` only to select another provider; legacy `AI_API_BASE` and `DSPY_API_BASE` remain fallbacks.
- `AI_PROVIDER` is used only for LiteLLM routing. The model sent upstream remains the raw `AI_MODEL` unless you explicitly prefix `AI_MODEL`.
- A `GET /` returning `404` from the upstream model server is usually harmless (many OpenAI-compatible servers only expose `/v1/*`).
