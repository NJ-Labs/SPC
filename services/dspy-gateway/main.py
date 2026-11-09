from __future__ import annotations

import bisect
import hmac
import json
import logging
import math
import mimetypes
import os
import re
import socket
import ssl
import sys
import tempfile
import threading
import time
import uuid
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal
from urllib.parse import urlparse

os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "true"

from dotenv import dotenv_values, load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from env_config import AIConfig, resolve_ai_config

import dspy
import litellm
from dspy.utils.exceptions import AdapterParseError
from dspy.utils.usage_tracker import track_usage

try:
    from spc_visuals import build_spc_visual
except ImportError:  # pragma: no cover - images that copy only main.py lose the visual fallback, nothing else
    build_spc_visual = None


logger = logging.getLogger("spc.dspy_gateway")

COMBINED_CA_BUNDLE_PATH = Path(tempfile.gettempdir()) / "spc-combined-ca-bundle.pem"
BUNDLED_CA_BUNDLE_PATH = Path(os.getenv("SPC_DEFAULT_CA_BUNDLE", "/app/certs/bluecoat-ca-bundle.pem"))
FRONTEND_INDEX_FILE = "index.html"
DEFAULT_GATEWAY_API_KEY = "e696c6b7ce2f111bc0b9cd731f3d314fc862ebe193b2cd29d01c3f396ac4a1f9"


def resolve_env_path() -> Path:
    override = os.getenv("SPC_ENV_FILE")
    if override:
        return Path(override).expanduser().resolve()

    current_file = Path(__file__).resolve()
    # Local development has one primary configuration file at the frontend project root.
    # An older gateway-local .env remains a fallback or an explicit SPC_ENV_FILE override.
    for parent in current_file.parents:
        candidate = parent / ".env"
        if (parent / "package.json").is_file() and candidate.is_file():
            return candidate
    for parent in current_file.parents:
        candidate = parent / ".env"
        if candidate.is_file():
            return candidate

    return current_file.parent / ".env"


ENV_PATH = resolve_env_path()
load_dotenv(dotenv_path=ENV_PATH, override=True)

MANAGED_ENV_KEYS = (
    "AI_API_URL",
    "AI_API_KEY",
    "AI_MODEL",
    "AI_PROVIDER",
    "AI_API_BASE",
    "AI_GATEWAY_API_KEY",
    "AI_GATEWAY_PORT",
    "VITE_AI_API_URL",
    "VITE_AI_MODEL",
    "VITE_AI_API_KEY",
    "DSPY_API_KEY",
    "OPENAI_API_KEY",
    "DSPY_API_BASE",
    "DSPY_TEMPERATURE",
    "DSPY_MAX_TOKENS",
    "DSPY_TIMEOUT_SECONDS",
    "DSPY_GATEWAY_API_KEY",
    "DSPY_GATEWAY_PORT",
    "DSPY_AGENT_MAX_ITERS",
    "DSPY_AGENT_DEADLINE_SECONDS",
    "DSPY_AGENT_MAX_TOKENS",
    "DSPY_HTML_MAX_TOKENS",
    "DSPY_MAX_REQUEST_CHARS",
    "DSPY_JSON_ADAPTER_FALLBACK",
    "SPC_KNOWLEDGE_DIR",
)

DEFAULT_GATEWAY_PORT = 8001
KNOWN_PROVIDER_PREFIXES = (
    "openai/",
    "azure/",
    "anthropic/",
    "bedrock/",
    "cohere/",
    "gemini/",
    "vertex_ai/",
    "groq/",
    "mistral/",
    "ollama/",
    "together_ai/",
    "huggingface/",
    "replicate/",
    "deepseek/",
    "xai/",
)


def sync_managed_env_from_root() -> None:
    if not ENV_PATH.is_file():
        return

    values = dotenv_values(ENV_PATH)
    for key in MANAGED_ENV_KEYS:
        value = values.get(key)
        if value is None:
            os.environ.pop(key, None)
            continue
        os.environ[key] = str(value)


def configure_combined_ca_bundle() -> None:
    """Keep TLS verification enabled with explicit, bundled, or Windows-trusted roots."""
    ca_bundle = next(
        (os.environ[key].strip() for key in ("REQUESTS_CA_BUNDLE", "SSL_CERT_FILE") if os.getenv(key, "").strip()),
        None,
    )
    if ca_bundle and Path(ca_bundle) == COMBINED_CA_BUNDLE_PATH:
        return
    custom_bytes = b""
    if ca_bundle:
        custom_path = Path(ca_bundle).expanduser()
        if not custom_path.is_file():
            logger.warning("Configured CA bundle was not found. Check REQUESTS_CA_BUNDLE or SSL_CERT_FILE.")
            return
        custom_bytes = custom_path.read_bytes()
    else:
        candidates = [BUNDLED_CA_BUNDLE_PATH]
        candidates.extend(parent / "deploy" / "docker" / "certs" / "bluecoat-ca-bundle.pem" for parent in Path(__file__).resolve().parents if (parent / "package.json").is_file())
        bundled = next((candidate for candidate in candidates if candidate.is_file()), None)
        if bundled:
            custom_bytes = bundled.read_bytes()
        if sys.platform == "win32":
            # Python knows the Windows trust store; HTTPX/LiteLLM normally use certifi alone.
            context = ssl.create_default_context()
            custom_bytes += b"\n".join(ssl.DER_cert_to_PEM_cert(cert).encode("ascii") for cert in context.get_ca_certs(binary_form=True))
    if not custom_bytes:
        return
    try:
        import certifi
        combined_bytes = Path(certifi.where()).read_bytes() + b"\n" + custom_bytes
        COMBINED_CA_BUNDLE_PATH.parent.mkdir(parents=True, exist_ok=True)
        if not COMBINED_CA_BUNDLE_PATH.is_file() or COMBINED_CA_BUNDLE_PATH.read_bytes() != combined_bytes:
            # Readers must never see a partially written certificate bundle during a reload.
            with tempfile.NamedTemporaryFile(dir=COMBINED_CA_BUNDLE_PATH.parent, prefix="spc-ca-", delete=False) as temporary:
                temporary.write(combined_bytes)
                temporary_path = Path(temporary.name)
            try:
                os.replace(temporary_path, COMBINED_CA_BUNDLE_PATH)
            finally:
                temporary_path.unlink(missing_ok=True)
    except Exception as exc:
        logger.warning("Could not prepare trusted CA bundle (%s).", type(exc).__name__)
        return
    combined_value = str(COMBINED_CA_BUNDLE_PATH)
    os.environ["REQUESTS_CA_BUNDLE"] = combined_value
    os.environ["SSL_CERT_FILE"] = combined_value
    os.environ["CURL_CA_BUNDLE"] = combined_value


def _ancestor(path: Path, levels: int) -> Path | None:
    # Container layouts such as /app/main.py have fewer ancestors than the repo layout.
    parents = path.parents
    return parents[levels] if len(parents) > levels else None


def resolve_frontend_dist_path() -> Path | None:
    override = os.getenv("SPC_WEB_DIST_DIR")
    if override:
        candidate = Path(override).expanduser().resolve()
        if candidate.is_dir():
            return candidate

    current_file = Path(__file__).resolve()
    repo_root = _ancestor(current_file, 2)
    candidates = [current_file.parent / "spc-web-dist"]
    if repo_root is not None:
        candidates.append(repo_root / "dist")
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved.is_dir():
            return resolved

    return None


def resolve_knowledge_root() -> Path | None:
    override = os.getenv("SPC_KNOWLEDGE_DIR")
    if override:
        candidate = Path(override).expanduser().resolve()
        return candidate if candidate.is_dir() else None

    current_file = Path(__file__).resolve()
    candidates = [current_file.parent / "knowledge", current_file.parent / "docs" / "knowledge"]
    candidates.extend(parent / "docs" / "knowledge" for parent in current_file.parents)
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    return None


def build_runtime_app_config() -> dict[str, object]:
    gateway_api_key = env_first("AI_GATEWAY_API_KEY", "DSPY_GATEWAY_API_KEY") or DEFAULT_GATEWAY_API_KEY
    ai_model = env_first("AI_MODEL", "VITE_AI_MODEL") or ""

    return {
        "ENV": os.getenv("APP_ENV") or "runtime",
        "FEATURES": {},
        "AI": {
            "API_URL": "/",
            "API_KEY": gateway_api_key,
            "MODEL": ai_model,
        },
    }


def runtime_config_response() -> Response:
    with gateway._lock:
        gateway._reload_env_if_changed()
        config_payload = json.dumps(build_runtime_app_config(), ensure_ascii=True, indent=2)
    return Response(content=f"window.APP_CONFIG = {config_payload};\n", media_type="application/javascript")


sync_managed_env_from_root()
configure_combined_ca_bundle()
FRONTEND_DIST_DIR = resolve_frontend_dist_path()


def env_first(*keys: str) -> str | None:
    for key in keys:
        value = os.getenv(key)
        if value is None:
            continue
        trimmed = value.strip()
        if trimmed:
            return trimmed
    return None


class AIConfigurationError(RuntimeError):
    pass


def active_gateway_port() -> int:
    # The dev launcher pins the actual socket port; .env reloads do not move a running server.
    value = env_first("SPC_GATEWAY_BIND_PORT", "AI_GATEWAY_PORT", "DSPY_GATEWAY_PORT") or str(DEFAULT_GATEWAY_PORT)
    try:
        port = int(value)
    except ValueError:
        raise AIConfigurationError("Invalid AI_GATEWAY_PORT: use an integer from 1 to 65535.") from None
    if not 1 <= port <= 65535:
        raise AIConfigurationError("Invalid AI_GATEWAY_PORT: use an integer from 1 to 65535.")
    return port


def resolved_ai_config() -> AIConfig:
    try:
        return resolve_ai_config(dict(os.environ), gateway_port=active_gateway_port())
    except ValueError as exc:
        raise AIConfigurationError(str(exc)) from None


def env_int(key: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(float(env_first(key) or default))
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


def env_flag(key: str, default: bool = False) -> bool:
    value = env_first(key)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def frontend_file_response(relative_path: str) -> FileResponse | None:
    if FRONTEND_DIST_DIR is None:
        return None

    sanitized_path = relative_path.strip("/")
    target = (FRONTEND_DIST_DIR / sanitized_path).resolve() if sanitized_path else (FRONTEND_DIST_DIR / FRONTEND_INDEX_FILE).resolve()
    if not target.is_relative_to(FRONTEND_DIST_DIR) or not target.is_file():
        return None

    media_type, _ = mimetypes.guess_type(str(target))
    return FileResponse(target, media_type=media_type)


def frontend_index_response() -> FileResponse:
    response = frontend_file_response("")
    if response is None:
        raise HTTPException(status_code=503, detail="SPC-web assets are not available")
    return response


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str | None = ""
    tool_call_id: str | None = None
    tool_calls: list[dict[str, object]] = Field(default_factory=list)


class ChatToolDefinition(BaseModel):
    type: Literal["function"] = "function"
    function: dict[str, object] = Field(default_factory=dict)


class ChatCompletionRequest(BaseModel):
    model: str | None = None
    messages: list[ChatMessage] = Field(default_factory=list)
    temperature: float | None = None
    max_tokens: int | None = None
    stream: bool = False
    tools: list[ChatToolDefinition] = Field(default_factory=list)
    tool_choice: str | dict[str, object] | None = None


ChartTypeName = Literal["individual", "pChart", "npChart", "cChart", "uChart", "xBarS", "xBarR", "ewma", "histogram", "scatterPlot"]
RuleSetName = Literal["nelson", "westernElectric"]


AGENT_CHART_TYPES = {
    "individual",
    "pChart",
    "npChart",
    "cChart",
    "uChart",
    "xBarS",
    "xBarR",
    "ewma",
    "histogram",
    "scatterPlot",
}
RULE_SETS = ("nelson", "westernElectric")
XBAR_CHART_TYPES = {"xBarS", "xBarR"}
ATTRIBUTE_CHART_TYPES = {"pChart", "npChart", "cChart", "uChart"}
# Settings the app's SPC analysis depends on; changing one makes the request's `processed` results stale.
ANALYTICAL_FIELDS = ("chartType", "yColumns", "xAxisColumn", "denominatorColumn", "sampleSize", "ruleSet")
# Settings that must fit the data together (chart family, Y, denominator, subgroup size).
FIT_FIELDS = ("chartType", "yColumns", "denominatorColumn", "sampleSize")

MAX_SAFE_INTEGER = 2**53 - 1
SAMPLE_SIZE_MIN = 2
SAMPLE_SIZE_MAX = 25


def sample_size_rule(chart_type: str | None) -> dict[str, Any]:
    """Mirror of src/utils/sampleSize.ts: P/NP take units inspected per row, U any positive units, the rest 2-25."""
    if chart_type in {"pChart", "npChart"}:
        return {"integer": True, "min": 1, "max": MAX_SAFE_INTEGER, "exclusiveMinimum": False}
    if chart_type == "uChart":
        return {"integer": False, "min": 0, "max": None, "exclusiveMinimum": True}
    return {"integer": True, "min": SAMPLE_SIZE_MIN, "max": SAMPLE_SIZE_MAX, "exclusiveMinimum": False}


def describe_sample_size_rule(chart_type: str | None) -> str:
    rule = sample_size_rule(chart_type)
    if not rule["integer"]:
        return "any number greater than 0 (units per row)"
    if rule["max"] == MAX_SAFE_INTEGER:
        return "a whole number of at least 1 (units inspected per row)"
    return f"a whole number from {rule['min']} to {rule['max']}"


def sample_size_error(value: Any, chart_type: str | None) -> str | None:
    number = _finite(value)
    rule = sample_size_rule(chart_type)
    valid = number is not None and (
        (number.is_integer() and rule["min"] <= number <= rule["max"]) if rule["integer"] else number > 0
    )
    return None if valid else f"{chart_type} sampleSize must be {describe_sample_size_rule(chart_type)}; got {value}."


def sample_size_is_used(state: dict[str, Any]) -> bool:
    """Whether the app's calculation reads sampleSize for this setup (P/U take n from a denominator column when set)."""
    chart_type = state.get("chartType")
    if chart_type in XBAR_CHART_TYPES:
        return len(_unique_strings(state.get("yColumns"))) <= 1
    if chart_type == "npChart":
        return True
    if chart_type in {"pChart", "uChart"}:
        return not state.get("denominatorColumn")
    return False


def effective_sample_size(state: dict[str, Any]) -> Any:
    columns = _unique_strings(state.get("yColumns"))
    return len(columns) if state.get("chartType") in XBAR_CHART_TYPES and len(columns) > 1 else state.get("sampleSize")


class AgentControls(BaseModel):
    chartType: ChartTypeName
    yColumns: list[str] = Field(default_factory=list)
    xAxisColumn: str | None = None
    denominatorColumn: str | None = None
    # Whole numbers for most charts; U charts accept fractional units per row (see sample_size_rule).
    sampleSize: int | float = 5
    effectiveSampleSize: int | float | None = None
    chartLabel: str | None = None
    zAxisLabel: str | None = None
    yAxisLabel: str | None = None
    showControlLimits: bool = True
    showCenterLine: bool = True
    showRuleViolations: bool = True
    showSigma1: bool = False
    showSigma2: bool = False
    showSigma3: bool = False
    colorScheme: str | None = None
    # Present only when the frontend lets users pick the run-rule set; gates agent edits of it.
    ruleSet: RuleSetName | None = None
    # Read-only context: the agent never sets specification limits.
    lowerSpecLimit: float | None = None
    upperSpecLimit: float | None = None
    targetValue: float | None = None


class AgentTurnRequest(BaseModel):
    model: str | None = None
    messages: list[ChatMessage] = Field(default_factory=list)
    language: Literal["en", "he"] = "en"
    controls: AgentControls
    availableHeaders: list[str] = Field(default_factory=list)
    worksheet: dict[str, Any] = Field(default_factory=dict)
    dataset: dict[str, Any] = Field(default_factory=dict)
    processed: dict[str, Any] | None = None
    selectedSheetIndex: int | None = None
    temperature: float | None = None
    max_tokens: int | None = None


class AgentControlPatch(BaseModel):
    """Documents the controlPatch shape; the harness emits it as a plain dict."""

    chartType: ChartTypeName | None = None
    yColumns: list[str] | None = None
    xAxisColumn: str | None = None
    denominatorColumn: str | None = None
    sampleSize: int | float | None = None
    chartLabel: str | None = None
    zAxisLabel: str | None = None
    yAxisLabel: str | None = None
    showControlLimits: bool | None = None
    showCenterLine: bool | None = None
    showRuleViolations: bool | None = None
    showSigma1: bool | None = None
    showSigma2: bool | None = None
    showSigma3: bool | None = None
    colorScheme: str | None = None
    ruleSet: RuleSetName | None = None
    applied: list[str] = Field(default_factory=list)
    skipped: list[str] = Field(default_factory=list)
    reason: str | None = None
    changes: list[dict[str, Any]] = Field(default_factory=list)
    rejected: list[dict[str, Any]] = Field(default_factory=list)
    unchanged: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class AgentTurnResponse(BaseModel):
    content: str
    reasoning: str | None = None
    controlPatch: dict[str, Any] | None = None
    toolTrace: list[dict[str, Any]] = Field(default_factory=list)
    knowledgeSources: list[str] = Field(default_factory=list)
    needsClarification: bool = False
    model: str = "unknown"
    usage: dict[str, int] | None = None
    # Additive fields; older frontends ignore them.
    status: Literal["ok", "fallback", "clarification"] = "ok"
    intent: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    evidence: dict[str, Any] | None = None
    grounding: dict[str, Any] | None = None
    stopReason: str | None = None


class ToolMetadata(BaseModel):
    name: str
    description: str
    parameters: dict[str, Any] = Field(default_factory=dict)
    markdown: str


class KnowledgeSelection(BaseModel):
    markdown: str
    sources: list[str]


class AgentRecommendationModel(BaseModel):
    chartType: ChartTypeName | None = None
    yColumns: list[str] = Field(default_factory=list)
    yColumn: str | None = None
    xAxisColumn: str | None = None
    denominatorColumn: str | None = None
    sampleSize: int | None = None
    chartLabel: str | None = None
    zAxisLabel: str | None = None
    yAxisLabel: str | None = None
    reason: str = ""


class AgentRecommendationEnvelope(BaseModel):
    recommendation: AgentRecommendationModel = Field(default_factory=AgentRecommendationModel)


# ---------------------------------------------------------------------------
# Context budgets. Small local models often have 4k-8k token windows, so every
# piece of model-visible context is bounded.
# ---------------------------------------------------------------------------

MAX_HISTORY_MESSAGES = 8
MAX_HISTORY_MESSAGE_CHARS = 1200
# Hard cap on the latest user message. It is never truncated: longer requests get HTTP 413.
DEFAULT_MAX_LATEST_REQUEST_CHARS = 16000
# Only topic matching for knowledge selection reads this much of each user message.
MAX_KNOWLEDGE_FOCUS_CHARS = 4000
MAX_KNOWLEDGE_CHARS = 6000
MAX_CHAT_KNOWLEDGE_CHARS = 3500
MAX_KNOWLEDGE_DOCS = 3
MAX_OBSERVATION_CHARS = 3000
MAX_TRACE_RESULT_CHARS = 4000
MAX_REASONING_CHARS = 2000
MAX_HEADERS_IN_EVIDENCE = 60
MAX_UPDATE_CALLS = 4
MAX_LABEL_CHARS = 120
MAX_HTML_BLOCK_CHARS = 20000


def _finite(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _round_sig(value: float, digits: int = 6) -> float:
    return float(f"{value:.{digits}g}")


def _fmt(value: Any, digits: int = 6) -> str:
    number = _finite(value)
    if number is None:
        return "n/a"
    if number.is_integer() and abs(number) < 1e12:
        return str(int(number))
    return f"{number:.{digits}g}"


def _fmt_index(value: Any) -> str:
    number = _finite(value)
    return "n/a" if number is None else f"{number:.2f}"


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 14)].rstrip() + " …(truncated)"


def _compact(value: Any, *, max_list: int = 12, max_str: int = 240, depth: int = 0) -> Any:
    if depth > 6:
        return "…"
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return _round_sig(value) if math.isfinite(value) else None
    if isinstance(value, str):
        return value if len(value) <= max_str else value[:max_str] + "…"
    if isinstance(value, dict):
        items = list(value.items())
        compacted = {str(key): _compact(item, max_list=max_list, max_str=max_str, depth=depth + 1) for key, item in items[:40]}
        if len(items) > 40:
            compacted["…"] = f"{len(items) - 40} more keys"
        return compacted
    if isinstance(value, (list, tuple)):
        compacted_list = [_compact(item, max_list=max_list, max_str=max_str, depth=depth + 1) for item in value[:max_list]]
        if len(value) > max_list:
            compacted_list.append(f"… {len(value) - max_list} more")
        return compacted_list
    return _truncate(str(value), max_str)


def compact_json(value: Any, max_chars: int = MAX_OBSERVATION_CHARS) -> str:
    return _truncate(json.dumps(_compact(value), ensure_ascii=False, separators=(",", ":")), max_chars)


def _clean_text(value: Any, limit: int = MAX_LABEL_CHARS) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = re.sub(r"[\x00-\x1f\x7f]+", " ", value)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return None
    return cleaned[:limit].rstrip()


def _unique_strings(values: Any) -> list[str]:
    if not isinstance(values, list):
        return []
    selected: list[str] = []
    for value in values:
        if not isinstance(value, str):
            continue
        trimmed = value.strip()
        if trimmed and trimmed not in selected:
            selected.append(trimmed)
    return selected


# ---------------------------------------------------------------------------
# Lenient argument normalization. Weaker models paraphrase enum values, send
# booleans as strings, or change header case; normalize before validating.
# ---------------------------------------------------------------------------

CHART_TYPE_ALIASES: dict[str, ChartTypeName] = {
    "individual": "individual",
    "individuals": "individual",
    "i": "individual",
    "imr": "individual",
    "xmr": "individual",
    "individualsmovingrange": "individual",
    "individualmovingrange": "individual",
    "p": "pChart",
    "proportion": "pChart",
    "fractiondefective": "pChart",
    "fractionnonconforming": "pChart",
    "np": "npChart",
    "numberdefective": "npChart",
    "numbernonconforming": "npChart",
    "c": "cChart",
    "defectcount": "cChart",
    "u": "uChart",
    "defectsperunit": "uChart",
    "xbars": "xBarS",
    "xbarands": "xBarS",
    "xbarstddev": "xBarS",
    "xbarstdev": "xBarS",
    "xbarsigma": "xBarS",
    "xbarr": "xBarR",
    "xbarandr": "xBarR",
    "xbarrange": "xBarR",
    "ewma": "ewma",
    "exponentiallyweightedmovingaverage": "ewma",
    "histogram": "histogram",
    "hist": "histogram",
    "scatter": "scatterPlot",
    "xy": "scatterPlot",
}


def normalize_chart_type(value: Any) -> ChartTypeName | None:
    if not isinstance(value, str):
        return None
    raw = value.strip()
    if raw in AGENT_CHART_TYPES:
        return raw  # type: ignore[return-value]
    key = raw.lower().replace("x̄", "xbar").replace("x̅", "xbar")
    key = re.sub(r"[\s_\-–—/().,&+]+", "", key)
    key = re.sub(r"(charts?|plots?|graph)$", "", key)
    return CHART_TYPE_ALIASES.get(key)


def normalize_rule_set(value: Any) -> RuleSetName | None:
    if not isinstance(value, str):
        return None
    key = re.sub(r"[\s_\-]+", "", value.strip().lower())
    if key in {"nelson", "nelsonrules", "nelsontests", "nelson8"}:
        return "nelson"
    if key in {"westernelectric", "we", "werules", "westernelectricrules", "western"}:
        return "westernElectric"
    return None


def resolve_column(value: Any, headers: list[str]) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    if trimmed in headers:
        return trimmed
    folded = trimmed.casefold()
    matches = [header for header in headers if header.strip().casefold() == folded]
    return matches[0] if len(matches) == 1 else None


TRUE_WORDS = {"true", "yes", "y", "on", "1", "show", "enable", "enabled"}
FALSE_WORDS = {"false", "no", "n", "off", "0", "hide", "disable", "disabled"}
NONE_WORDS = {"", "none", "null", "nil", "n/a", "row", "rows", "index", "row index", "row order", "implicit"}


def coerce_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower().rstrip(".")
        if lowered in TRUE_WORDS:
            return True
        if lowered in FALSE_WORDS:
            return False
    return None


def coerce_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return int(round(value))
    if isinstance(value, str):
        match = re.search(r"-?\d+(?:\.\d+)?", value)
        if match:
            return int(round(float(match.group(0))))
    return None


def coerce_number(value: Any) -> int | float | None:
    """Finite number from a model argument ("12", "0.5 units"), kept as int when whole."""
    number: float | None = None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        match = re.search(r"-?\d+(?:\.\d+)?", value)
        number = float(match.group(0)) if match else None
    if number is None or not math.isfinite(number):
        return None
    return int(number) if number.is_integer() and abs(number) <= MAX_SAFE_INTEGER else number


def coerce_column_list(value: Any, headers: list[str]) -> list[str]:
    if isinstance(value, str):
        if resolve_column(value, headers):
            return [value]
        return [part for part in re.split(r"[,;\n]", value) if part.strip()]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return []


def _parse_bool(value: Any) -> bool:
    coerced = coerce_bool(value)
    if coerced is not None:
        return coerced
    if isinstance(value, str):
        return value.strip().lower().startswith(("true", "yes"))
    return False


# ---------------------------------------------------------------------------
# Tool contract
# ---------------------------------------------------------------------------

EDITABLE_FIELDS = (
    "chartType",
    "yColumns",
    "xAxisColumn",
    "denominatorColumn",
    "sampleSize",
    "chartLabel",
    "zAxisLabel",
    "yAxisLabel",
    "showControlLimits",
    "showCenterLine",
    "showRuleViolations",
    "showSigma1",
    "showSigma2",
    "showSigma3",
    "colorScheme",
    "ruleSet",
)
TEXT_FIELDS = ("chartLabel", "zAxisLabel", "yAxisLabel")
BOOL_FIELDS = ("showControlLimits", "showCenterLine", "showRuleViolations", "showSigma1", "showSigma2", "showSigma3")
ARG_ALIASES = {
    "yColumn": "yColumns",
    "y": "yColumns",
    "columns": "yColumns",
    "column": "yColumns",
    "xAxis": "xAxisColumn",
    "xColumn": "xAxisColumn",
    "denominator": "denominatorColumn",
    "subgroupSize": "sampleSize",
    "n": "sampleSize",
    "title": "chartLabel",
    "chartTitle": "chartLabel",
    "xAxisLabel": "zAxisLabel",
    "chart": "chartType",
    "type": "chartType",
    "rules": "ruleSet",
}
READ_CONTROLS_SECTIONS = ("current", "available", "worksheet", "assistant", "dataset", "processed", "diagnostics")
DIAGNOSTIC_SECTIONS = (
    "dataProfile",
    "diagnostics",
    "chartRecommendations",
    "capabilityStatus",
    "ruleViolationCount",
    "ruleSummary",
    "variationRuleSummary",
    "controlLimits",
    "statistics",
    "specLimits",
)

TOOL_PARAMETER_SCHEMAS: dict[str, dict[str, Any]] = {
    "list-tools": {
        "type": "object",
        "additionalProperties": False,
        "properties": {},
    },
    "read_controls": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "include": {
                "type": "array",
                "items": {"type": "string", "enum": list(READ_CONTROLS_SECTIONS)},
                "description": "Optional snapshot sections. Omit for current, available, and worksheet.",
            },
        },
    },
    "read_spc_diagnostics": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "include": {
                "type": "array",
                "items": {"type": "string", "enum": list(DIAGNOSTIC_SECTIONS)},
                "description": "Optional diagnostic sections. Omit to return all SPC diagnostics.",
            },
        },
    },
    "update_controls": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "chartType": {"type": ["string", "null"], "enum": [*sorted(AGENT_CHART_TYPES), None]},
            "yColumns": {"type": "array", "items": {"type": "string"}},
            "xAxisColumn": {"type": ["string", "null"]},
            "denominatorColumn": {"type": ["string", "null"]},
            "sampleSize": {
                "type": ["number", "null"],
                "exclusiveMinimum": 0,
                "maximum": MAX_SAFE_INTEGER,
                "description": "X-bar R/S, I-MR, C, EWMA: whole number 2-25. P/NP: whole number >= 1 (units inspected per row). U: any number > 0 (units per row).",
            },
            "chartLabel": {"type": ["string", "null"], "maxLength": MAX_LABEL_CHARS},
            "zAxisLabel": {"type": ["string", "null"], "maxLength": MAX_LABEL_CHARS},
            "yAxisLabel": {"type": ["string", "null"], "maxLength": MAX_LABEL_CHARS},
            "showControlLimits": {"type": "boolean"},
            "showCenterLine": {"type": "boolean"},
            "showRuleViolations": {"type": "boolean"},
            "showSigma1": {"type": "boolean"},
            "showSigma2": {"type": "boolean"},
            "showSigma3": {"type": "boolean"},
            "colorScheme": {"type": ["string", "null"]},
            "ruleSet": {"type": ["string", "null"], "enum": [*RULE_SETS, None]},
            "reason": {"type": ["string", "null"]},
        },
    },
}

# What the model sees in the ReAct prompt. Validation happens in Python, so the
# schema is deliberately permissive and short.
MODEL_TOOL_ARGS: dict[str, dict[str, Any]] = {
    "list-tools": {},
    "read_controls": {
        "include": {"description": "optional list: current, available, worksheet, dataset"},
    },
    "read_spc_diagnostics": {
        "include": {"description": "optional list: dataProfile, diagnostics, chartRecommendations, capabilityStatus, ruleSummary, variationRuleSummary, controlLimits, statistics, specLimits"},
    },
    "update_controls": {
        "chartType": {"description": "individual|pChart|npChart|cChart|uChart|xBarR|xBarS|ewma|histogram|scatterPlot"},
        "yColumns": {"description": "list of exact header names"},
        "xAxisColumn": {"description": "header name, or null for row order"},
        "denominatorColumn": {"description": "header with units/opportunities per row (P/U charts), or null"},
        "sampleSize": {"description": "X-bar/I-MR/C/EWMA: whole 2-25; P/NP: whole >= 1 units inspected per row; U: any > 0 units per row"},
        "chartLabel": {"description": "chart title"},
        "zAxisLabel": {"description": "x-axis label"},
        "yAxisLabel": {"description": "y-axis label"},
        "showControlLimits": {"description": "true/false"},
        "showCenterLine": {"description": "true/false"},
        "showRuleViolations": {"description": "true/false"},
        "showSigma1": {"description": "true/false"},
        "showSigma2": {"description": "true/false"},
        "showSigma3": {"description": "true/false"},
        "ruleSet": {"description": "nelson (8 tests) or westernElectric (4 rules)"},
        "reason": {"description": "one short sentence"},
    },
}

TOOL_DESCRIPTIONS = {
    "list-tools": "List the tools and their arguments. Never changes anything.",
    "read_controls": "Read current chart settings, valid column names, and allowed options. Never changes anything.",
    "read_spc_diagnostics": "Read app-computed SPC results: data profile, diagnostics, chart candidates, limits, rule signals, capability. Never changes anything.",
    "update_controls": "Change chart settings in the app. Pass only fields to change. The app validates them and returns changes and rejections with reasons.",
}


TOOL_MARKDOWN: dict[str, str] = {
    "list-tools": """# list-tools

Purpose: Show the assistant every SPC UI tool it can use.

Use this when:
- You need to confirm available tool names before acting.
- You need the argument contract or safety rules for a tool.

Inputs: none.

Returns:
- `tools`: name, description, and JSON-style parameters for each tool.

Safety:
- This tool never changes chart settings.
""",
    "read_controls": """# read_controls

Purpose: Read current SPC chart controls, worksheet metadata, available options, and bounded dataset context.

Use this when:
- Current chart type, selected columns, labels, overlays, rule set, or sample size matter.
- You need to validate column names before calling `update_controls`.

Inputs:
- `include`: optional list of sections: `current`, `available`, `worksheet`, `assistant`, `dataset`, `processed`, `diagnostics`.
  Omit it to get `current`, `available`, and `worksheet`.

Returns:
- A JSON object containing the selected snapshot sections. Large arrays are never included.
- `available.sampleSize` gives the rule for the current chart (`integer`, `min`, `max`, `exclusiveMinimum`) and the
  exact `current` and `effective` values.
- `available.unverifiedHeaders` lists columns without a full-data profile; changes that depend on them are rejected.
- `processed` and `diagnostics` are replaced by a stale notice once an analytical setting changed in this turn.

Safety:
- This tool never changes chart settings.
- Always use active-sheet headers when choosing columns.
""",
    "read_spc_diagnostics": """# read_spc_diagnostics

Purpose: Read app-computed SPC evidence: data profile, diagnostics, chart candidates, control limits,
rule signals (with the active rule set), variation-chart (MR/R/S) signals, capability readiness and indices.

Use this when:
- You might change chart type based on data structure.
- You need to know whether P/U denominators, count data, time order, or subgroup assumptions are valid.
- You need to explain stability, rule signals, or capability.

Inputs:
- `include`: optional list of sections: `dataProfile`, `diagnostics`, `chartRecommendations`, `capabilityStatus`,
  `ruleViolationCount`, `ruleSummary`, `variationRuleSummary`, `controlLimits`, `statistics`, `specLimits`.

Returns:
- A JSON object containing the selected diagnostic sections from the current processed dataset.
- Every number is computed by the app; quote it, never recompute it.
- After `update_controls` changed chart type, Y columns, X axis, denominator, sample size, or rule set in this turn,
  it returns `available: false` with `analysisStale: true` and no statistics: the earlier results describe the
  previous setup and the app recalculates only after the browser applies the patch.

Safety:
- This tool never changes chart settings.
""",
    "update_controls": """# update_controls

Purpose: Propose validated updates to the SPC UI controls.

Use this when:
- The user asks to apply or configure an SPC chart, or Agent Mode autopilot asks for a setup.

Inputs (pass only fields you want to change):
- `chartType`: individual, pChart, npChart, cChart, uChart, xBarS, xBarR, ewma, histogram, scatterPlot.
- `yColumns`: ordered Y-axis columns from active-sheet headers.
- `xAxisColumn`: active-sheet column or null for implicit row order.
- `denominatorColumn`: units/opportunities column for P/U charts, or null.
- `sampleSize`: depends on the chart (validated against the chart this update leaves in place):
  X-bar R/S, I-MR, C, EWMA: whole number 2..25; P/NP: whole number >= 1 (units inspected per row);
  U: any number > 0 (units per row). Out-of-range or fractional whole-number sizes are rejected, never clamped.
- `chartLabel`, `zAxisLabel`, `yAxisLabel`: labels (max 120 characters).
- Overlay booleans: `showControlLimits`, `showCenterLine`, `showRuleViolations`, `showSigma1`, `showSigma2`, `showSigma3`.
- `colorScheme`: chart color scheme identifier.
- `ruleSet`: `nelson` (8 tests) or `westernElectric` (4 rules), when the app exposes the rule-set control.
- `reason`: short explanation for the update.

Validation:
- Common paraphrases are normalized (for example "X-bar R" -> xBarR, "true" -> true, header case).
- Unknown columns and invalid values are rejected with a reason; nothing is guessed.
- Y columns must be numeric. Attribute charts must fit the data: P needs proportions, or counts with a denominator
  of positive whole numbers; NP/C/U need non-negative integer counts; U denominators must be positive;
  NP needs a constant subgroup size and no denominator column.
- Chart type, Y columns, denominator, and sample size are checked together. If the resulting setup does not fit the
  data, every one of those fields requested in the call is rejected and the current analytical setup stays;
  labels, overlays, and colors in the same call still apply.
- A column the app could not profile over every row cannot be verified, so a change that depends on it is
  rejected with "Cannot verify ..." instead of being assumed valid.
- For X-bar R/S charts with multiple Y columns, sample size is locked to the number of Y columns (each row is a subgroup).
- Specification limits cannot be changed by the assistant.

Returns:
- `patch`: cumulative browser-applyable changes for this turn, with `changes` (field, from, to),
  `rejected` (field, value, reason), `applied`, `skipped`, `unchanged`, and `warnings`.
- `ok`: false when any requested field was rejected in this call.
- `analysis`: present when an analytical setting changed; the app's earlier statistics no longer describe the
  setup and are recalculated only after the browser applies the patch.

Safety:
- This tool mutates only request-local Python state.
- The browser remains responsible for applying the returned patch.
""",
}


# ---------------------------------------------------------------------------
# Knowledge
# ---------------------------------------------------------------------------

# Always included; also the fallback when docs/knowledge is not shipped with the service.
CORE_SPC_KNOWLEDGE = """# Core SPC rules (always apply)
- One continuous measurement per sample (n=1) calls for I-MR. X-bar R/S require confirmed rational subgroups with at least two measurements. Never infer rational subgroups from a stored sampleSize, the row count, or X-axis labels. sampleSize is unused for I-MR and EWMA; a configured X-bar grouping still needs process-context confirmation.
- Control limits (UCL/LCL) are computed from process data (voice of the process). Specification limits (LSL/USL/target) come from requirements (voice of the customer). Never derive one from the other, and never call a point "out of control" because it is outside a spec limit.
- Stability is judged with control limits and run rules. Capability (Cp/Cpk/Pp/Ppk/Cpm) compares spread and centering to spec limits; it needs at least one spec limit, continuous data, and a stable process to be decision-ready.
- Cp/Cpk use within-process sigma (I-MR: MR-bar/1.128; X-bar R: R-bar/d2; X-bar S: S-bar/c4). Pp/Ppk use the overall sample standard deviation. Usually Cp >= Pp; a large gap means shifts or drift between subgroups.
- On X-bar charts the plotted sigma is the standard error (process sigma / sqrt(n)); do not confuse it with process sigma.
- P/NP/C/U are attribute charts: no Cp/Cpk. P = proportion (counts with a denominator, or 0-1 values); NP = count defective with constant n; C = defect count with constant opportunity; U = defects per unit with a denominator.
- Run rules: the app uses Nelson's 8 tests by default (1 one point beyond 3 sigma; 2 nine in a row on one side; 3 six in a row increasing or decreasing; 4 fourteen alternating; 5 two of three beyond 2 sigma same side; 6 four of five beyond 1 sigma same side; 7 fifteen within 1 sigma; 8 eight beyond 1 sigma on both sides). The classic Western Electric set has 4 rules (1 beyond 3 sigma; 2 two of three beyond 2 sigma; 3 four of five beyond 1 sigma; 4 eight in a row on one side). Rule numbers differ between sets, so always name the set.
- MR/R/S charts monitor short-term variation; check them before trusting the location chart's limits.
- A rule signal means "investigate for a special cause", not "defective product". Count signals (pattern windows), not flagged points.
- All numbers (limits, sigma, indices, rule counts) are computed by the app. Quote them; never recalculate or invent them. An index the app reports as n/a stays n/a (for example Cp/Cpk when within sigma is zero, or Cpm when the target is outside the specs).
"""

KNOWLEDGE_TOPICS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("control-chart-rules.md", re.compile(r"\b(rules?|nelson|western\s*electric|run\s*rules?|violations?|signals?|out[\s-]of[\s-]control|special[\s-]cause|zones?|trend|shifts?)\b|חוק|חריג", re.I)),
    ("capability-performance.md", re.compile(r"\b(capab\w*|cp|cpk|pp|ppk|cpm|cpl|cpu|spec(ification)?s?|lsl|usl|tolerance|within\s*sigma|overall\s*sigma)\b|יכולת|מפרט", re.I)),
    ("i-mr.md", re.compile(r"\b(i[\s-]?mr|imr|xmr|individuals?|moving\s*ranges?)\b", re.I)),
    ("xbar-r.md", re.compile(r"\b(x[\s-]?bar[\s-]?(and[\s-]?)?r|xbarr|range\s*chart|r\s*chart)\b", re.I)),
    ("xbar-s.md", re.compile(r"\b(x[\s-]?bar[\s-]?(and[\s-]?)?s|xbars|s\s*chart)\b", re.I)),
    ("attribute-charts.md", re.compile(r"\b(n?p|c|u)[\s-]?charts?\b|\b(attribute|defects?|defectives?|nonconform\w*|denominators?|opportunit\w*|proportions?)\b", re.I)),
    ("chart-selection.md", re.compile(r"\b(which|choose|select\w*|recommend\w*|best|suitable|appropriate)\b[^.?!]{0,40}\bcharts?\b|\bchart\s*(selection|type)\b|\bdata\s*profile\b|\bdiagnos\w*", re.I)),
    ("ewma.md", re.compile(r"\bewma\b|exponentially\s*weighted|small\s*(shifts?|drifts?)|\bdrift\w*", re.I)),
    ("measurement-system.md", re.compile(r"\b(gage|gauge|msa|measurement\s*system|resolution|repeatab\w*|reproducib\w*|grr)\b", re.I)),
    ("semiconductor-playbook.md", re.compile(r"\b(semiconductor|wafers?|fab|metrology|reticle|lithograph\w*|etch|cmp|chambers?)\b", re.I)),
    ("automotive-core-tools.md", re.compile(r"\b(aiag|automotive|apqp|ppap|control\s*plan|iatf|fmea)\b", re.I)),
    ("pharma-cpv-pat.md", re.compile(r"\b(pharma\w*|cpv|pat|cqa|cpp|continued\s*process\s*verification|gmp)\b", re.I)),
)

CHART_TYPE_DOCS: dict[str, str] = {
    "individual": "i-mr.md",
    "xBarR": "xbar-r.md",
    "xBarS": "xbar-s.md",
    "pChart": "attribute-charts.md",
    "npChart": "attribute-charts.md",
    "cChart": "attribute-charts.md",
    "uChart": "attribute-charts.md",
    "ewma": "ewma.md",
    "histogram": "chart-selection.md",
    "scatterPlot": "chart-selection.md",
}


class SPCKnowledgeLoader:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or resolve_knowledge_root()
        self._cache_key: tuple[int, float] | None = None
        self._cache: dict[str, str] = {}

    def _current_key(self) -> tuple[int, float] | None:
        if self.root is None or not self.root.is_dir():
            return None
        mtimes = [path.stat().st_mtime for path in self.root.glob("*.md") if path.is_file()]
        return (len(mtimes), max(mtimes, default=0.0))

    def load(self) -> dict[str, str]:
        key = self._current_key()
        if key == self._cache_key:
            return dict(self._cache)

        docs: dict[str, str] = {}
        if self.root is not None and self.root.is_dir():
            for path in sorted(self.root.glob("*.md")):
                if path.is_file():
                    docs[path.name] = path.read_text(encoding="utf-8", errors="replace").strip()

        self._cache = docs
        self._cache_key = key
        return dict(docs)

    @staticmethod
    def _select_source_names(text: str) -> list[str]:
        return [name for name, pattern in KNOWLEDGE_TOPICS if pattern.search(text)]

    def select_for_text(self, focus_text: str, chart_type: str | None = None, budget: int = MAX_KNOWLEDGE_CHARS) -> KnowledgeSelection:
        docs = self.load()
        names = [name for name in self._select_source_names(focus_text) if name in docs]
        default_doc = CHART_TYPE_DOCS.get(chart_type or "")
        if default_doc in docs and default_doc not in names:
            # The current chart's doc is useful context, but only after explicitly requested topics.
            names.append(default_doc)
        if not names and "chart-selection.md" in docs:
            names.append("chart-selection.md")

        parts = [CORE_SPC_KNOWLEDGE.strip()]
        remaining = budget - len(parts[0])
        sources: list[str] = []
        for name in names[:MAX_KNOWLEDGE_DOCS]:
            if remaining < 400:
                break
            body = docs[name]
            if len(body) > remaining:
                body = _truncate(body, remaining)
            parts.append(f"<!-- source: {name} -->\n{body}")
            sources.append(name)
            remaining -= len(body)
        return KnowledgeSelection(markdown="\n\n".join(parts), sources=sources)

    def select(self, request: AgentTurnRequest) -> KnowledgeSelection:
        # Only user wording and the chart state steer selection; dataset headers/rows would
        # produce spurious matches (a "Die" column is not a semiconductor question).
        user_texts = [
            (message.content or "")[:MAX_KNOWLEDGE_FOCUS_CHARS]
            for message in request.messages
            if message.role == "user" and (message.content or "").strip()
        ][-3:]
        processed = request.processed or {}
        profile = processed.get("dataProfile") if isinstance(processed.get("dataProfile"), dict) else {}
        focus = "\n".join([*user_texts, str(profile.get("dataKind") or "")])
        return self.select_for_text(focus, chart_type=request.controls.chartType)

    def document_count(self) -> int:
        return len(self.load())


# ---------------------------------------------------------------------------
# Intent detection (deterministic hints; the model still decides)
# ---------------------------------------------------------------------------

INTENT_PATTERNS: dict[str, re.Pattern[str]] = {
    "change": re.compile(r"\b(set|switch|change|use|apply|configure|make|plot|show|hide|display|turn\s+(on|off)|enable|disable|select|pick|rename|label|title|undo|revert|add|remove)\b|שנה|החלף|הגדר|הצג|הסתר|בחר|הפעל|כבה", re.I),
    "capability": re.compile(r"\b(capab\w*|cpk?|ppk?|cpm|spec(ification)?s?|lsl|usl)\b|יכולת", re.I),
    "rules": re.compile(r"\b(rules?|nelson|western\s*electric|violations?|signals?|out[\s-]of[\s-]control|special[\s-]causes?|flag(ged|s)?)\b|חוק|חריג", re.I),
    "diagnostics": re.compile(r"\b(diagnos\w*|data\s*profile|assumptions?|normality|autocorrel\w*|skew\w*|blockers?)\b|אבחון", re.I),
    "limits": re.compile(r"\b(control\s*limits?|ucl|lcl|cent(er|re)\s*line|sigma)\b|σ|גבולות", re.I),
    "evidence": re.compile(r"\b(evidence|statistics|stats|show\s+(me\s+)?(the\s+)?(numbers|results))\b|ראיות|סטטיסטיק", re.I),
    "html": re.compile(r"\b(interactive|html|widget|simulat\w*|animat\w*|playground|demo|sliders?)\b|אינטראקטיב|הדמי|סימולצ", re.I),
}
AUTOPILOT_PATTERN = re.compile(r"agent mode is enabled|מצב agent פעיל", re.I)
EVIDENCE_INTENT_SECTIONS: dict[str, tuple[str, ...]] = {
    "capability": ("capability",),
    "rules": ("rules",),
    "limits": ("limits",),
    "diagnostics": ("diagnostics",),
    "evidence": ("statistics", "limits", "rules", "capability", "diagnostics"),
}


def detect_intents(text: str) -> list[str]:
    if AUTOPILOT_PATTERN.search(text):
        # Autopilot prompts embed a dataset summary full of SPC vocabulary; only the
        # setup intent is meaningful there.
        return ["autopilot", "change"]
    return [name for name, pattern in INTENT_PATTERNS.items() if pattern.search(text)]


def evidence_sections_for(intents: list[str]) -> list[str]:
    sections: list[str] = []
    for intent in intents:
        for section in EVIDENCE_INTENT_SECTIONS.get(intent, ()):
            if section not in sections:
                sections.append(section)
    return sections


# ---------------------------------------------------------------------------
# Deterministic evidence (all numbers come from the frontend's SPC analysis)
# ---------------------------------------------------------------------------

RULE_SET_LABELS = {
    "nelson": "Nelson (8 tests)",
    "westernElectric": "Western Electric (4 rules)",
}
VARIATION_CHART_NAMES = {"individual": "MR", "ewma": "MR", "xBarR": "R", "xBarS": "S"}


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _series_range(values: Any) -> dict[str, Any] | None:
    numbers = [number for number in (_finite(item) for item in _list(values)) if number is not None]
    if not numbers:
        return None
    return {"min": _round_sig(min(numbers)), "max": _round_sig(max(numbers))}


def summarize_rule_violations(violations: list[Any], rule_set: str | None) -> dict[str, Any]:
    """Server-side equivalent of the frontend summary, for clients that still send raw violations.

    Per-record `signalCount` (windows ending at that point) sums to the exact signal count; older
    engines only give window endpoints, and the oldest only flagged points.
    """
    by_rule: dict[int, dict[str, Any]] = {}
    flagged: set[int] = set()
    for item in violations:
        violation = _dict(item)
        rule_number = coerce_int(violation.get("ruleNumber"))
        index = coerce_int(violation.get("index"))
        if rule_number is None or index is None:
            continue
        flagged.add(index)
        entry = by_rule.setdefault(rule_number, {
            "ruleNumber": rule_number,
            "description": _clean_text(violation.get("description"), 160) or "",
            "points": set(),
            "endpoints": set(),
            "counted": 0,
            "hasSignalCount": False,
            "hasEndpoints": False,
        })
        entry["points"].add(index)
        signal_count = violation.get("signalCount")
        if isinstance(signal_count, int) and not isinstance(signal_count, bool):
            entry["hasSignalCount"] = True
            entry["counted"] += max(0, signal_count)
            if signal_count > 0:
                entry["endpoints"].add(index)
            continue
        window_ends = [coerce_int(_dict(signal).get("signalIndex")) for signal in _list(violation.get("signals"))]
        window_ends = [value for value in window_ends if value is not None]
        single = coerce_int(violation.get("signalIndex"))
        if single is not None:
            window_ends.append(single)
        if window_ends:
            entry["hasEndpoints"] = True
            entry["endpoints"].update(window_ends)
        else:
            entry["endpoints"].add(index)
    rules = []
    exact = True
    for rule_number in sorted(by_rule):
        entry = by_rule[rule_number]
        exact = exact and (entry["hasSignalCount"] or entry["hasEndpoints"])
        points = sorted(entry["points"])
        endpoints = sorted(entry["endpoints"])
        rules.append({
            "ruleNumber": rule_number,
            "description": entry["description"],
            "signalCount": entry["counted"] if entry["hasSignalCount"] else len(endpoints),
            "pointCount": len(points),
            "firstIndex": points[0],
            "lastIndex": points[-1],
            "signalIndices": endpoints[:12],
        })
    return {
        "ruleSet": rule_set or "nelson",
        "signalCount": sum(rule["signalCount"] for rule in rules),
        "flaggedPointCount": len(flagged),
        "exactSignalCounts": exact,
        "rules": rules,
    }


def _normalize_rule_summary(raw: Any, rule_set: str | None) -> dict[str, Any] | None:
    summary = _dict(raw)
    if not summary:
        return None
    rules = []
    for item in _list(summary.get("rules"))[:12]:
        rule = _dict(item)
        rule_number = coerce_int(rule.get("ruleNumber"))
        if rule_number is None:
            continue
        rules.append({
            "ruleNumber": rule_number,
            "description": _clean_text(rule.get("description"), 160) or "",
            "signalCount": coerce_int(rule.get("signalCount")) or 0,
            "pointCount": coerce_int(rule.get("pointCount")) or 0,
            "firstIndex": coerce_int(rule.get("firstIndex")),
            "lastIndex": coerce_int(rule.get("lastIndex")),
            "signalIndices": [value for value in (coerce_int(v) for v in _list(rule.get("signalIndices"))[:12]) if value is not None],
        })
    return {
        "ruleSet": summary.get("ruleSet") if summary.get("ruleSet") in RULE_SETS else (rule_set or "nelson"),
        "signalCount": coerce_int(summary.get("signalCount")) if summary.get("signalCount") is not None else sum(rule["signalCount"] for rule in rules),
        "flaggedPointCount": coerce_int(summary.get("flaggedPointCount")) or 0,
        "exactSignalCounts": summary.get("exactSignalCounts") is not False,
        "rules": rules,
    }


def build_spc_evidence(request: AgentTurnRequest) -> dict[str, Any]:
    controls = request.controls
    processed = _dict(request.processed)
    dataset = _dict(request.dataset)
    y_columns = _unique_strings(controls.yColumns)
    rule_set = controls.ruleSet or _dict(processed.get("ruleSummary")).get("ruleSet") or "nelson"
    if rule_set not in RULE_SETS:
        rule_set = "nelson"
    headers = request.availableHeaders or [h for h in _list(dataset.get("headers")) if isinstance(h, str)]

    evidence: dict[str, Any] = {
        "available": bool(processed),
        "chart": {
            "chartType": controls.chartType,
            "yColumns": y_columns,
            "xAxisColumn": controls.xAxisColumn,
            "denominatorColumn": controls.denominatorColumn,
            "sampleSize": controls.sampleSize,
            "effectiveSampleSize": effective_sample_size({"chartType": controls.chartType, "yColumns": y_columns, "sampleSize": controls.sampleSize}),
            "ruleSet": rule_set,
            "ruleSetSelectable": controls.ruleSet is not None,
        },
        "dataset": {
            "rows": coerce_int(dataset.get("rowCount")),
            "columns": coerce_int(dataset.get("columnCount")) or len(headers),
            "headers": headers[:MAX_HEADERS_IN_EVIDENCE],
            "headersTruncated": len(headers) > MAX_HEADERS_IN_EVIDENCE,
            "sheet": _dict(request.worksheet).get("activeSheetName"),
        },
    }

    profile = _dict(processed.get("dataProfile"))
    if profile:
        evidence["profile"] = {
            key: (_round_sig(profile[key], 4) if isinstance(profile.get(key), float) and math.isfinite(profile[key]) else profile.get(key))
            for key in (
                "column", "dataKind", "rowCount", "numericCount", "missingCount", "nonNumericCount",
                "tieRate", "skewness", "lag1Autocorrelation", "timeOrdered", "integerLike", "nonNegative",
                "hasVaryingDenominator",
            )
            if key in profile
        }

    statistics = _dict(processed.get("statistics"))
    if statistics:
        evidence["statistics"] = {
            key: _round_sig(_finite(statistics.get(key))) if _finite(statistics.get(key)) is not None else None
            for key in ("mean", "standardDeviation", "min", "max", "count")
        }

    limits = _dict(processed.get("controlLimits"))
    if limits:
        limit_evidence: dict[str, Any] = {
            "centerLine": _finite(limits.get("centerLine")),
            "ucl": _finite(limits.get("ucl")),
            "lcl": _finite(limits.get("lcl")),
            "sigmaPlotted": _finite(limits.get("sigma")),
            "processSigma": _finite(limits.get("processSigma")),
            "sigmaMethod": _clean_text(limits.get("sigmaMethod"), 60),
        }
        variable = _dict(limits.get("variableLimits"))
        if not variable and (limits.get("uclSeries") or limits.get("lclSeries")):
            # Older clients send full series; reduce them to ranges here.
            variable = {"ucl": _series_range(limits.get("uclSeries")), "lcl": _series_range(limits.get("lclSeries"))}
        if variable:
            limit_evidence["variableLimits"] = _compact(variable)
        variation = _dict(limits.get("variationChart"))
        if variation:
            limit_evidence["variationChart"] = {
                "name": variation.get("name") or VARIATION_CHART_NAMES.get(controls.chartType, "variation"),
                "centerLine": _finite(variation.get("centerLine")),
                "ucl": _finite(variation.get("ucl")),
                "lcl": _finite(variation.get("lcl")),
            }
        evidence["limits"] = {key: (_round_sig(value) if isinstance(value, float) else value) for key, value in limit_evidence.items()}

    rules = _normalize_rule_summary(processed.get("ruleSummary"), rule_set)
    if rules is None and isinstance(processed.get("ruleViolations"), list):
        rules = summarize_rule_violations(processed["ruleViolations"], rule_set)
    if rules is None and processed:
        rules = {"ruleSet": rule_set, "flaggedPointCount": coerce_int(processed.get("ruleViolationCount")) or 0, "rules": [], "detailAvailable": False}
    if rules is not None:
        evidence["rules"] = rules

    variation_rules = _normalize_rule_summary(processed.get("variationRuleSummary"), rule_set)
    if variation_rules is None and isinstance(processed.get("variationRuleViolations"), list):
        variation_rules = summarize_rule_violations(processed["variationRuleViolations"], rule_set)
    if variation_rules is not None:
        variation_rules["chart"] = VARIATION_CHART_NAMES.get(controls.chartType, "variation")
        evidence["variationRules"] = variation_rules

    capability = _dict(processed.get("capabilityStatus"))
    specs = _dict(processed.get("specLimits"))
    spec_values = {
        "lowerSpecLimit": _finite(specs.get("lowerSpecLimit", controls.lowerSpecLimit)),
        "upperSpecLimit": _finite(specs.get("upperSpecLimit", controls.upperSpecLimit)),
        "targetValue": _finite(specs.get("targetValue", controls.targetValue)),
    }
    if capability or any(value is not None for value in spec_values.values()):
        indices = _dict(capability.get("indices"))
        sigma_estimate = _dict(capability.get("sigmaEstimate"))
        evidence["capability"] = {
            "readiness": capability.get("readiness"),
            "reasons": [text for text in (_clean_text(reason, 200) for reason in _list(capability.get("reasons"))[:5]) if text],
            "specs": spec_values,
            "indices": {
                key: (round(_finite(indices.get(key)), 3) if _finite(indices.get(key)) is not None else None)
                for key in ("cp", "cpk", "cpl", "cpu", "pp", "ppk", "ppl", "ppu", "cpm")
            },
            "sigmaWithin": _round_sig(_finite(sigma_estimate.get("within"))) if _finite(sigma_estimate.get("within")) is not None else None,
            "sigmaOverall": _round_sig(_finite(sigma_estimate.get("overall"))) if _finite(sigma_estimate.get("overall")) is not None else None,
            "sigmaMethod": _clean_text(sigma_estimate.get("method"), 60),
            "observationCount": coerce_int(sigma_estimate.get("observationCount")),
        }

    candidates = []
    for item in _list(processed.get("chartRecommendations"))[:3]:
        candidate = _dict(item)
        if candidate.get("chartType"):
            candidates.append({
                "chartType": candidate.get("chartType"),
                "status": candidate.get("status"),
                "score": _finite(candidate.get("score")),
                "reason": _clean_text(candidate.get("reason"), 200),
            })
    if candidates:
        evidence["candidates"] = candidates

    diagnostics = []
    for item in _list(processed.get("diagnostics"))[:8]:
        diagnostic = _dict(item)
        if diagnostic.get("code") or diagnostic.get("message"):
            diagnostics.append({
                "severity": diagnostic.get("severity"),
                "code": diagnostic.get("code"),
                "message": _clean_text(diagnostic.get("message"), 220),
            })
    if diagnostics:
        evidence["diagnostics"] = diagnostics

    return evidence


def _point_label(chart_type: str) -> str:
    return "subgroup" if chart_type in XBAR_CHART_TYPES else "point"


def _rule_lines(rules: dict[str, Any], chart_type: str, prefix: str) -> list[str]:
    rule_set = RULE_SET_LABELS.get(rules.get("ruleSet") or "nelson", "Nelson (8 tests)")
    unit = _point_label(chart_type)
    if rules.get("detailAvailable") is False:
        return [f"{prefix} ({rule_set}): {rules.get('flaggedPointCount', 0)} flagged {unit}s (per-rule detail not provided)."]
    if not rules.get("rules"):
        return [f"{prefix} ({rule_set}): no rule signals."]
    approx = "" if rules.get("exactSignalCounts", True) else " (approximate: counted from flagged points)"
    lines = [f"{prefix} ({rule_set}): {rules.get('signalCount', 0)} signal(s){approx}, {rules.get('flaggedPointCount', 0)} flagged {unit}(s)."]
    for rule in rules["rules"]:
        endpoints = ", ".join(f"#{index + 1}" for index in rule.get("signalIndices", [])[:6])
        lines.append(
            f"  rule {rule['ruleNumber']} ({rule['description']}): {rule['signalCount']} signal(s) ending at {endpoints or 'n/a'}; {rule['pointCount']} {unit}(s) involved."
        )
    return lines


def evidence_prompt_text(evidence: dict[str, Any], stale_fields: list[str] | None = None) -> str:
    """Model-visible evidence. With `stale_fields`, the settings line shows the pending setup and no statistics."""
    chart = evidence["chart"]
    dataset = evidence["dataset"]
    lines = [
        "SETTINGS: chart={chartType}; Y=[{y}]; X={x}; denominator={den}; n={n} (effective {eff}); rule set={rs}{rs_note}".format(
            chartType=chart["chartType"],
            y=", ".join(chart["yColumns"]) or "none",
            x=chart["xAxisColumn"] or "row order",
            den=chart["denominatorColumn"] or "none",
            n=chart["sampleSize"],
            eff=chart["effectiveSampleSize"],
            rs=RULE_SET_LABELS.get(chart["ruleSet"], chart["ruleSet"]),
            rs_note="" if chart.get("ruleSetSelectable") else " (not selectable)",
        ),
        "DATA: {rows} rows, {cols} columns{sheet}. HEADERS: {headers}{more}".format(
            rows=dataset["rows"] if dataset["rows"] is not None else "?",
            cols=dataset["columns"],
            sheet=f", sheet {dataset['sheet']}" if dataset.get("sheet") else "",
            headers=", ".join(dataset["headers"]) or "none",
            more=" …" if dataset.get("headersTruncated") else "",
        ),
    ]
    if stale_fields:
        lines.append(
            f"APP ANALYSIS: out of date. {', '.join(stale_fields)} changed in this turn; the app recalculates limits, "
            "rule signals, capability and diagnostics only after the browser applies the change. "
            "Quote no statistics seen earlier in this turn; say the results will be recalculated."
        )
        return "\n".join(lines)
    if not evidence["available"]:
        lines.append("APP ANALYSIS: not available (no Y column selected or no processed data). Do not invent statistics.")
        return "\n".join(lines)

    profile = evidence.get("profile")
    if profile:
        lines.append(
            "PROFILE({col}): kind={kind}; numeric {num}/{rows}; missing {miss}; non-numeric {nonnum}; tie rate {tie}; skew {skew}; lag-1 autocorrelation {lag}; time ordered={ordered}".format(
                col=profile.get("column") or "primary Y",
                kind=profile.get("dataKind", "?"),
                num=profile.get("numericCount", "?"),
                rows=profile.get("rowCount", "?"),
                miss=profile.get("missingCount", "?"),
                nonnum=profile.get("nonNumericCount", "?"),
                tie=_fmt(profile.get("tieRate"), 3),
                skew=_fmt(profile.get("skewness"), 3),
                lag=_fmt(profile.get("lag1Autocorrelation"), 3),
                ordered=profile.get("timeOrdered"),
            )
        )
    stats = evidence.get("statistics")
    if stats:
        lines.append(
            f"PLOTTED VALUES(app): mean={_fmt(stats.get('mean'))}; sigma used for limits={_fmt(stats.get('standardDeviation'))}; min={_fmt(stats.get('min'))}; max={_fmt(stats.get('max'))}; count={_fmt(stats.get('count'))}"
        )
    limits = evidence.get("limits")
    if limits:
        method = f" ({limits['sigmaMethod']})" if limits.get("sigmaMethod") else ""
        line = (
            f"CONTROL LIMITS(app): CL={_fmt(limits.get('centerLine'))}; UCL={_fmt(limits.get('ucl'))}; LCL={_fmt(limits.get('lcl'))}; "
            f"sigma of plotted statistic={_fmt(limits.get('sigmaPlotted'))}; within-process sigma={_fmt(limits.get('processSigma'))}{method}"
        )
        if limits.get("variableLimits"):
            line += f"; limits vary by point: {compact_json(limits['variableLimits'], 200)}"
        lines.append(line)
        variation = limits.get("variationChart")
        if variation:
            lines.append(
                f"{variation['name']} CHART LIMITS(app): CL={_fmt(variation.get('centerLine'))}; UCL={_fmt(variation.get('ucl'))}; LCL={_fmt(variation.get('lcl'))}"
            )
    if evidence.get("rules"):
        lines.extend(_rule_lines(evidence["rules"], evidence["chart"]["chartType"], "RULE SIGNALS(app)"))
    if evidence.get("variationRules"):
        variation_rules = evidence["variationRules"]
        lines.extend(_rule_lines(variation_rules, "variation", f"{variation_rules.get('chart', 'variation')} CHART SIGNALS(app)"))
    capability = evidence.get("capability")
    if capability:
        specs = capability["specs"]
        indices = capability["indices"]
        lines.append(
            "CAPABILITY(app): readiness={ready}; specs LSL={lsl}, USL={usl}, target={target}; Cp={cp}, Cpk={cpk} (within sigma {sw}); Pp={pp}, Ppk={ppk} (overall sigma {so}); Cpm={cpm}".format(
                ready=capability.get("readiness") or "unknown",
                lsl=_fmt(specs.get("lowerSpecLimit")),
                usl=_fmt(specs.get("upperSpecLimit")),
                target=_fmt(specs.get("targetValue")),
                cp=_fmt_index(indices.get("cp")),
                cpk=_fmt_index(indices.get("cpk")),
                pp=_fmt_index(indices.get("pp")),
                ppk=_fmt_index(indices.get("ppk")),
                cpm=_fmt_index(indices.get("cpm")),
                sw=_fmt(capability.get("sigmaWithin")),
                so=_fmt(capability.get("sigmaOverall")),
            )
        )
        if capability.get("reasons"):
            lines.append("  capability notes: " + " ".join(capability["reasons"]))
    for candidate in evidence.get("candidates", []):
        lines.append(f"CHART CANDIDATE(app): {candidate['chartType']} = {candidate.get('status')} (score {_fmt(candidate.get('score'))}): {candidate.get('reason') or ''}")
    for diagnostic in evidence.get("diagnostics", []):
        lines.append(f"DIAGNOSTIC(app): {diagnostic.get('severity')} {diagnostic.get('code')}: {diagnostic.get('message') or ''}")
    return "\n".join(lines)


EVIDENCE_LABELS = {
    "en": {
        "title": "App-computed evidence",
        "note": "Calculated by the app, not by the AI.",
        "metric": "Metric",
        "value": "Value",
        "basis": "Basis",
        "readiness": "Capability readiness",
        "specs": "LSL / USL / Target",
        "within": "within σ",
        "overall": "overall σ",
        "rule": "Rule",
        "signals": "Signals",
        "points": "Points involved",
        "endpoints": "Signal endpoints",
        "ruleSet": "Rule set",
        "noSignals": "No rule signals.",
        "noData": "No processed data yet: select a numeric Y column to get app-computed results.",
        "cl": "Center line",
        "sigmaPlotted": "σ of plotted statistic",
        "processSigma": "Within-process σ",
        "variable": "Limits vary by point",
        "candidates": "Chart candidates",
        "diagnostics": "Diagnostics",
        "profile": "Data profile",
        "statistics": "Plotted values",
        "mean": "Mean",
        "sd": "σ used for limits",
        "minmax": "Min / Max",
        "count": "Count",
    },
    "he": {
        "title": "ראיות שחושבו באפליקציה",
        "note": "חושב על ידי האפליקציה, לא על ידי ה-AI.",
        "metric": "מדד",
        "value": "ערך",
        "basis": "בסיס",
        "readiness": "מוכנות יכולת",
        "specs": "LSL / USL / יעד",
        "within": "σ פנימי",
        "overall": "σ כולל",
        "rule": "חוק",
        "signals": "אותות",
        "points": "נקודות מעורבות",
        "endpoints": "נקודות סיום",
        "ruleSet": "סט חוקים",
        "noSignals": "אין אותות חוקים.",
        "noData": "אין עדיין נתונים מעובדים: בחר עמודת Y מספרית כדי לקבל תוצאות מחושבות.",
        "cl": "קו מרכז",
        "sigmaPlotted": "σ של הסטטיסטי המוצג",
        "processSigma": "σ פנימי של התהליך",
        "variable": "גבולות משתנים לפי נקודה",
        "candidates": "תרשימים מועמדים",
        "diagnostics": "אבחונים",
        "profile": "פרופיל נתונים",
        "statistics": "ערכים מוצגים",
        "mean": "ממוצע",
        "sd": "σ ששימש לגבולות",
        "minmax": "מינימום / מקסימום",
        "count": "מספר תצפיות",
    },
}


def _rule_markdown(rules: dict[str, Any], labels: dict[str, str], heading: str) -> list[str]:
    lines = [f"**{heading}** — {labels['ruleSet']}: {RULE_SET_LABELS.get(rules.get('ruleSet') or 'nelson', 'Nelson (8 tests)')}"]
    if rules.get("detailAvailable") is False:
        lines.append(f"- {labels['points']}: {rules.get('flaggedPointCount', 0)}")
        return lines
    if not rules.get("rules"):
        lines.append(f"- {labels['noSignals']}")
        return lines
    lines.extend([
        f"| {labels['rule']} | {labels['signals']} | {labels['points']} | {labels['endpoints']} |",
        "|---|---|---|---|",
    ])
    for rule in rules["rules"]:
        endpoints = ", ".join(f"#{index + 1}" for index in rule.get("signalIndices", [])[:8]) or "—"
        description = rule["description"].replace("|", "/")
        lines.append(f"| {rule['ruleNumber']}: {description} | {rule['signalCount']} | {rule['pointCount']} | {endpoints} |")
    return lines


def evidence_markdown(evidence: dict[str, Any], sections: list[str], language: str) -> str:
    labels = EVIDENCE_LABELS.get(language, EVIDENCE_LABELS["en"])
    if not sections:
        return ""
    if not evidence.get("available"):
        return f"**{labels['title']}**\n\n- {labels['noData']}"

    blocks: list[str] = []
    if "statistics" in sections and evidence.get("statistics"):
        stats = evidence["statistics"]
        blocks.append("\n".join([
            f"**{labels['statistics']}**",
            f"| {labels['metric']} | {labels['value']} |",
            "|---|---|",
            f"| {labels['mean']} | {_fmt(stats.get('mean'))} |",
            f"| {labels['sd']} | {_fmt(stats.get('standardDeviation'))} |",
            f"| {labels['minmax']} | {_fmt(stats.get('min'))} / {_fmt(stats.get('max'))} |",
            f"| {labels['count']} | {_fmt(stats.get('count'))} |",
        ]))
    if "limits" in sections and evidence.get("limits"):
        limits = evidence["limits"]
        rows = [
            f"| {labels['cl']} | {_fmt(limits.get('centerLine'))} |",
            f"| UCL / LCL | {_fmt(limits.get('ucl'))} / {_fmt(limits.get('lcl'))} |",
            f"| {labels['sigmaPlotted']} | {_fmt(limits.get('sigmaPlotted'))} |",
        ]
        if limits.get("processSigma") is not None:
            method = f" ({limits['sigmaMethod']})" if limits.get("sigmaMethod") else ""
            rows.append(f"| {labels['processSigma']} | {_fmt(limits.get('processSigma'))}{method} |")
        variation = limits.get("variationChart")
        if variation:
            rows.append(
                f"| {variation['name']}: CL / UCL / LCL | {_fmt(variation.get('centerLine'))} / {_fmt(variation.get('ucl'))} / {_fmt(variation.get('lcl'))} |"
            )
        if limits.get("variableLimits"):
            rows.append(f"| {labels['variable']} | {compact_json(limits['variableLimits'], 160).replace('|', '/')} |")
        blocks.append("\n".join([f"**{labels['cl']} / UCL / LCL**", f"| {labels['metric']} | {labels['value']} |", "|---|---|", *rows]))
    if "rules" in sections and evidence.get("rules"):
        blocks.append("\n".join(_rule_markdown(evidence["rules"], labels, labels["rule"])))
        if evidence.get("variationRules"):
            variation_rules = evidence["variationRules"]
            blocks.append("\n".join(_rule_markdown(variation_rules, labels, f"{variation_rules.get('chart', 'MR')} {labels['rule']}")))
    if "capability" in sections and evidence.get("capability"):
        capability = evidence["capability"]
        specs = capability["specs"]
        indices = capability["indices"]
        rows = [
            f"| {labels['readiness']} | {capability.get('readiness') or 'n/a'} | app |",
            f"| {labels['specs']} | {_fmt(specs.get('lowerSpecLimit'))} / {_fmt(specs.get('upperSpecLimit'))} / {_fmt(specs.get('targetValue'))} | spec |",
        ]
        if capability.get("readiness") != "notApplicable":
            method = f", {capability['sigmaMethod']}" if capability.get("sigmaMethod") else ""
            rows.extend([
                f"| Cp / Cpk | {_fmt_index(indices.get('cp'))} / {_fmt_index(indices.get('cpk'))} | {labels['within']} = {_fmt(capability.get('sigmaWithin'))}{method} |",
                f"| Pp / Ppk | {_fmt_index(indices.get('pp'))} / {_fmt_index(indices.get('ppk'))} | {labels['overall']} = {_fmt(capability.get('sigmaOverall'))} |",
                f"| Cpm | {_fmt_index(indices.get('cpm'))} | {labels['overall']} |",
            ])
        block = [f"**{labels['readiness']}**", f"| {labels['metric']} | {labels['value']} | {labels['basis']} |", "|---|---|---|", *rows]
        block.extend(f"- {reason}" for reason in capability.get("reasons", []))
        blocks.append("\n".join(block))
    if "diagnostics" in sections:
        block: list[str] = []
        profile = evidence.get("profile")
        if profile:
            block.append(
                f"**{labels['profile']}**: {profile.get('dataKind', '?')}, {profile.get('numericCount', '?')}/{profile.get('rowCount', '?')} numeric, "
                f"skew {_fmt(profile.get('skewness'), 3)}, lag-1 {_fmt(profile.get('lag1Autocorrelation'), 3)}"
            )
        if evidence.get("diagnostics"):
            block.append(f"**{labels['diagnostics']}**")
            block.extend(f"- {item.get('severity')}: {item.get('message') or item.get('code')}" for item in evidence["diagnostics"])
        if evidence.get("candidates"):
            block.append(f"**{labels['candidates']}**")
            block.extend(f"- {item['chartType']} ({item.get('status')}): {item.get('reason') or ''}" for item in evidence["candidates"])
        if block:
            blocks.append("\n".join(block))
    if not blocks:
        return ""
    return f"**{labels['title']}** — _{labels['note']}_\n\n" + "\n\n".join(blocks)


# ---------------------------------------------------------------------------
# Output guards
# ---------------------------------------------------------------------------

FENCED_BLOCK_RE = re.compile(r"```[^\n]*\n[\s\S]*?```")
HTML_BLOCK_RE = re.compile(r"```html[^\n]*\n([\s\S]*?)```", re.I)
FORBIDDEN_HTML_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("external URL", re.compile(r"(?:src|href|action|poster|data|formaction)\s*=\s*[\"']?\s*(?:https?:|//|ftp:)", re.I)),
    ("external stylesheet", re.compile(r"@import|url\(\s*[\"']?\s*(?:https?:|//)", re.I)),
    ("external script", re.compile(r"<script[^>]*\bsrc\s*=", re.I)),
    ("embedded frame", re.compile(r"<\s*(?:iframe|frame|object|embed|base|link|portal)\b", re.I)),
    ("redirect", re.compile(r"http-equiv\s*=\s*[\"']?refresh|location\s*\.\s*(?:href|assign|replace)|window\s*\.\s*open\s*\(", re.I)),
    ("network call", re.compile(r"\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|RTCPeerConnection)\b|\bimport\s*\(", re.I)),
    ("app access", re.compile(r"\b(?:window\s*\.\s*)?(?:parent|top|opener)\s*\.|postMessage|document\s*\.\s*cookie|localStorage|sessionStorage|indexedDB|serviceWorker", re.I)),
    ("script URL", re.compile(r"javascript\s*:", re.I)),
)


def sanitize_html_blocks(text: str, language: str = "en") -> tuple[str, list[str]]:
    """Keep at most one self-contained ```html block; drop blocks that reach outside the sandbox.

    An unclosed ```html fence (typically a truncated reply) is cut off rather than shown as raw code.
    """
    warnings: list[str] = []
    kept = 0
    removed_note = (
        "_(הדגמה אינטראקטיבית הוסרה: היא לא עמדה בכללי הבטיחות של בלוק HTML עצמאי.)_"
        if language == "he"
        else "_(Interactive example removed: it did not meet the self-contained HTML safety rules.)_"
    )

    def replace(match: re.Match[str]) -> str:
        nonlocal kept
        body = match.group(1)
        problem = None
        if kept >= 1:
            problem = "only one interactive block is allowed per answer"
        elif len(body) > MAX_HTML_BLOCK_CHARS:
            problem = f"block exceeds {MAX_HTML_BLOCK_CHARS} characters"
        else:
            for label, pattern in FORBIDDEN_HTML_PATTERNS:
                if pattern.search(body):
                    problem = f"uses {label}"
                    break
        if problem is None:
            kept += 1
            return match.group(0)
        warnings.append(f"htmlBlockRemoved: {problem}")
        return removed_note

    sanitized = HTML_BLOCK_RE.sub(replace, text)
    masked = FENCED_BLOCK_RE.sub(lambda match: " " * len(match.group(0)), sanitized)
    unclosed = re.search(r"```html", masked, re.I)
    if unclosed:
        warnings.append("htmlBlockRemoved: unclosed block")
        sanitized = f"{sanitized[: unclosed.start()].rstrip()}\n\n{removed_note}".strip()
    return sanitized, warnings


def has_html_block(text: str) -> bool:
    return HTML_BLOCK_RE.search(text) is not None


def deterministic_visual(request: AgentTurnRequest, intents: list[str], language: str) -> str | None:
    """App-built interactive explanation for models that cannot write working HTML.

    Only the two built-in topics exist; any other request (EWMA weighting, scatter, zones...) gets no
    substitute rather than an unrelated rule explorer.
    """
    if build_spc_visual is None:
        return None
    if "capability" in intents:
        topic = "capability"
    elif "rules" in intents:
        topic = "rules"
    else:
        return None
    try:
        fragment = build_spc_visual(request.processed, request.controls.model_dump(), topic, language)
    except Exception:
        logger.exception("Deterministic SPC visual failed")
        return None
    if not fragment:
        return None
    block = f"```html\n{fragment}\n```"
    # The app-built fragment must pass the same policy as model-written HTML.
    sanitized, problems = sanitize_html_blocks(block, language)
    return block if not problems and sanitized == block else None


# A sign belongs to a number only when nothing word-like precedes it ("9.7-10.3" is a range, "lag-1" a name).
NUMBER_TOKEN_RE = re.compile(
    r"(?<![\w.#])(?P<sign>[-−]?)(?P<digits>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?P<percent>%?)(?!\.?\d)(?!\w)"
)
REFERENCE_NUMBER_RE = re.compile(r"(?:(?<![\w.])(?P<sign>[-−]))?(?P<number>\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)")
DATE_TIME_RE = re.compile(
    r"\b\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b"
)
# Integers that name things rather than state results: rule/test numbers, sigma multiples, list markers.
RULE_NUMBER_CONTEXT_RE = re.compile(
    r"(?:\b(?:rules?|tests?|criteri(?:on|a)|zones?|steps?|options?)|חוק(?:ים)?|כלל(?:ים)?|מבחנ(?:ים)?)\s*(?:no\.?|number|#)?\s*"
    r"(?:[-−]?\d+\s*(?:,|and|or|&|/|-|–|to|ו)\s*)*$",
    re.I,
)
SIGMA_AFTER_RE = re.compile(r"^\s*[-‑–]?\s*(?:sigma\b|σ|sd\b|s\.d\.|std\b|standard[\s-]+deviations?|סיגמ)", re.I)
SIGMA_BEFORE_RE = re.compile(r"(?:±|\+/-|\+-)\s*$")
# Small integers are checked only when stated as a statistic's value ("Cpk is 3", "UCL = 7").
STATISTIC_CLAIM_RE = re.compile(
    r"(?:\b(?:cpk|cpm|cpl|cpu|cp|ppk|ppl|ppu|pp|ucl|lcl|cl|mean|average|median|sigma|std|stdev|index)\b|σ)\s*(?:\([^)\n]{0,20}\)\s*)?"
    r"(?:is|was|are|were|=|:|≈|~|of|at|equals?|reaches|reached)\s*(?:about|approximately|around|roughly|only|just|~)?\s*$",
    re.I,
)
SMALL_INTEGER_LIMIT = 10


def _numbers_in(value: Any, sink: list[float], depth: int = 0) -> None:
    if depth > 8:
        return
    if isinstance(value, bool) or value is None:
        return
    if isinstance(value, (int, float)):
        number = float(value)
        if math.isfinite(number):
            sink.append(number)
        return
    if isinstance(value, str):
        for match in REFERENCE_NUMBER_RE.finditer(value):
            try:
                number = float(match.group("number"))
            except ValueError:
                continue
            if math.isfinite(number):
                sink.append(-number if match.group("sign") else number)
        return
    if isinstance(value, dict):
        for item in value.values():
            _numbers_in(item, sink, depth + 1)
        return
    if isinstance(value, (list, tuple)):
        for item in value[:2000]:
            _numbers_in(item, sink, depth + 1)


def collect_reference_numbers(*sources: Any) -> list[float]:
    numbers: list[float] = []
    for source in sources:
        _numbers_in(source, numbers)
    return sorted(set(numbers))


def _is_grounded(value: float, decimals: int, references: list[float]) -> bool:
    tolerance = 0.5 * 10 ** (-decimals) + 1e-9
    position = bisect.bisect_left(references, value - tolerance)
    return position < len(references) and references[position] <= value + tolerance


def _mask(text: str, pattern: re.Pattern[str]) -> str:
    return pattern.sub(lambda match: " " * len(match.group(0)), text)


def _is_exempt_integer(prose: str, start: int, end: int, value: float) -> bool:
    before = prose[max(0, start - 60):start]
    after = prose[end:end + 30]
    if RULE_NUMBER_CONTEXT_RE.search(before) or SIGMA_BEFORE_RE.search(before) or SIGMA_AFTER_RE.match(after):
        return True
    line_start = before.rsplit("\n", 1)[-1]
    if re.fullmatch(r"\s*(?:[-*>]\s*)?", line_start) and re.match(r"[.)]\s", after + " "):
        return True  # numbered-list marker
    if abs(value) <= SMALL_INTEGER_LIMIT and not STATISTIC_CLAIM_RE.search(before):
        return True  # counts of things in prose ("2 columns", "top 3"), not a stated statistic
    return False


def find_ungrounded_numbers(answer: str, references: list[float], exempt_terms: Any = ()) -> list[str]:
    """Numbers in prose that are not a rounding of any app/user-provided number, sign included.

    Decimals are always checked. Integers are checked unless they name a rule/test, a sigma multiple, a list item,
    or are small counts not stated as a statistic's value. Code, dates, times, and header names are ignored.
    """
    prose = FENCED_BLOCK_RE.sub(" ", answer)
    prose = re.sub(r"`[^`\n]*`", " ", prose)
    for term in sorted((t for t in exempt_terms if isinstance(t, str) and re.search(r"\d", t)), key=len, reverse=True):
        prose = prose.replace(term, " " * len(term))
    prose = _mask(prose, DATE_TIME_RE)
    ungrounded: list[str] = []
    for match in NUMBER_TOKEN_RE.finditer(prose):
        digits = match.group("digits").replace(",", "")
        is_percent = bool(match.group("percent"))
        try:
            value = float(digits)
        except ValueError:
            continue
        if match.group("sign"):
            value = -value
        decimals = len(digits.split(".", 1)[1]) if "." in digits else 0
        if decimals:
            if SIGMA_AFTER_RE.match(prose[match.end():match.end() + 30]):
                continue
        elif _is_exempt_integer(prose, match.start(), match.end(), value):
            continue
        grounded = _is_grounded(value, decimals, references)
        if not grounded and is_percent:
            grounded = _is_grounded(value / 100, decimals + 2, references)
        token = match.group(0)
        if not grounded and token not in ungrounded:
            ungrounded.append(token)
    return ungrounded[:8]


CHANGE_CLAIM_RE = re.compile(
    r"\b(?:i\s*(?:'ve|have)?\s*(?:now\s+)?(?:switched|changed|updated|set|applied|configured|selected|enabled|disabled|turned|renamed)"
    r"|(?:has|have)\s+(?:now\s+)?been\s+(?:switched|changed|updated|applied|configured))\b"
    r"|שיניתי|עדכנתי|הגדרתי|החלפתי|הוחלף|עודכן",
    re.I,
)

FIELD_MARKER_RE = re.compile(r"\[\[\s*##\s*(\w+)\s*##\s*\]\]")


def rescue_answer_from_raw(raw: Any) -> str:
    """Recover a usable answer when a small model ignores the field-marker format."""
    text = raw if isinstance(raw, str) else ""
    text = text.strip()
    if not text:
        return ""
    if text.startswith("{"):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, dict) and isinstance(parsed.get("answer"), str):
                return parsed["answer"].strip()
        except ValueError:
            pass
    markers = list(FIELD_MARKER_RE.finditer(text))
    if markers:
        for index, marker in enumerate(markers):
            if marker.group(1) == "answer":
                end = markers[index + 1].start() if index + 1 < len(markers) else len(text)
                return text[marker.end():end].strip()
        # Field markers without an answer section: drop reasoning/tool fields entirely.
        return ""
    return text


def clean_model_answer(text: Any) -> str:
    answer = str(text or "").strip()
    answer = FIELD_MARKER_RE.sub("", answer).strip()
    # Legacy recommendation JSON is meaningless in tool mode and must never look like an applied change.
    if '"recommendation"' in answer:
        answer = AgentRecommendationHarness.strip_structured_blocks(answer)
    return answer


# ---------------------------------------------------------------------------
# Tool session with trusted validation
# ---------------------------------------------------------------------------


class SPCAgentToolSession:
    def __init__(self, request: AgentTurnRequest, tool_metadata: list[ToolMetadata], evidence: dict[str, Any] | None = None) -> None:
        self.request = request
        self.tool_metadata = tool_metadata
        self.evidence = evidence if evidence is not None else build_spc_evidence(request)
        self.headers = list(request.availableHeaders)
        self.original: dict[str, Any] = request.controls.model_dump()
        self.current: dict[str, Any] = dict(self.original)
        self.rejections: dict[str, dict[str, Any]] = {}
        self.warnings: list[str] = []
        self.reason: str | None = None
        self.trace: list[dict[str, Any]] = []
        self.update_calls = 0
        self.column_profiles = self._parse_column_profiles(request.dataset.get("columnProfiles"))

    # -- helpers -----------------------------------------------------------

    @staticmethod
    def _parse_column_profiles(raw: Any) -> dict[str, dict[str, Any]]:
        profiles: dict[str, dict[str, Any]] = {}
        entries = raw.items() if isinstance(raw, dict) else ((None, item) for item in _list(raw))
        for key, item in entries:
            profile = _dict(item)
            name = profile.get("name") or key
            if isinstance(name, str) and name:
                profiles[name] = profile
        return profiles

    def _column_profile(self, column: str | None) -> dict[str, Any] | None:
        """Normalized column facts. `exact` is true only for full-data profiles; others can refute but not confirm."""
        if not column:
            return None
        profile = self.column_profiles.get(column)
        if profile is not None:
            exact = profile.get("sampled") is False
            return {
                "numeric": coerce_int(profile.get("numeric")) or 0,
                "integerLike": profile.get("integerLike") if isinstance(profile.get("integerLike"), bool) else None,
                "nonNegative": profile.get("nonNegative") if isinstance(profile.get("nonNegative"), bool) else None,
                "min": _finite(profile.get("min")),
                "max": _finite(profile.get("max")),
                "exact": exact,
                "source": "columnProfile" if exact else "sampledProfile",
            }
        # Older clients only send the app's full-data profile of the currently charted column.
        data_profile = _dict(_dict(self.request.processed).get("dataProfile"))
        original_primary = (_unique_strings(self.original.get("yColumns")) or [None])[0]
        if data_profile and column == original_primary and data_profile.get("column") in (None, column):
            kind = data_profile.get("dataKind")
            numeric = coerce_int(data_profile.get("numericCount"))
            integer = data_profile.get("integerLike")
            if not isinstance(integer, bool):
                integer = True if kind in {"count", "binary"} else False if kind in {"continuous", "proportion"} else None
            non_negative = data_profile.get("nonNegative")
            if not isinstance(non_negative, bool):
                non_negative = True if kind in {"count", "binary", "proportion"} else None
            return {
                "numeric": numeric if numeric is not None else 1,
                "integerLike": integer,
                "nonNegative": non_negative,
                "min": _finite(data_profile.get("min")) if data_profile.get("min") is not None else (0.0 if kind in {"binary", "proportion"} else None),
                "max": _finite(data_profile.get("max")) if data_profile.get("max") is not None else (1.0 if kind in {"binary", "proportion"} else None),
                "exact": True,
                "source": "dataProfile",
            }
        return None

    def _verify(self, column: str | None, requirement: str, size: Any = None) -> bool | None:
        """True when the data confirms the requirement, False when it refutes it, None when it cannot be verified."""
        profile = self._column_profile(column)
        if profile is None:
            return None
        if profile["numeric"] == 0:
            # A partial (sampled) profile with no numbers may simply not have reached the numeric rows.
            return False if profile["exact"] else None
        if requirement == "numeric":
            return True
        integer, non_negative, low, high = profile["integerLike"], profile["nonNegative"], profile["min"], profile["max"]
        limit = _finite(size)
        if requirement == "counts":
            refuted = integer is False or non_negative is False or (low is not None and low < 0)
            confirmed = integer is True and non_negative is True
        elif requirement == "proportions":
            refuted = (low is not None and low < 0) or (high is not None and high > 1)
            confirmed = low is not None and high is not None
        elif requirement == "positiveIntegers":
            refuted = integer is False or (low is not None and low <= 0)
            confirmed = integer is True and low is not None and low >= 1
        elif requirement == "positive":
            refuted = low is not None and low <= 0
            confirmed = low is not None
        elif requirement == "maxAtMost":
            refuted = high is not None and limit is not None and high > limit
            confirmed = high is not None and limit is not None
        else:
            raise ValueError(f"unknown column requirement {requirement!r}")
        if refuted:
            return False
        return True if confirmed and profile["exact"] else None

    REQUIREMENT_TEXT = {
        "numeric": "numeric values",
        "counts": "non-negative whole-number counts",
        "proportions": "proportions between 0 and 1",
        "positiveIntegers": "positive whole numbers (units inspected per row)",
        "positive": "positive values (units or opportunities per row)",
        "maxAtMost": "counts no larger than the subgroup size",
    }

    def _unverified_reason(self, columns: list[str], requirement: str) -> str:
        sources = {(self._column_profile(column) or {}).get("source", "missing") for column in columns}
        if "missing" in sources:
            why = "the app sent no column profile for it"
        elif "sampledProfile" in sources:
            why = "its column profile covers only part of the rows (older app version)"
        else:
            why = "the app's data profile does not report it"
        names = ", ".join(f"'{column}'" for column in columns)
        return (
            f"Cannot verify that {names} holds {self.REQUIREMENT_TEXT[requirement]}: {why}. "
            "Reload the app so it profiles every row, or make this change in the chart controls yourself."
        )

    def _unverified_headers(self) -> list[str]:
        return [header for header in self.headers if (self._column_profile(header) or {}).get("exact") is not True]

    # -- analysis freshness --------------------------------------------------

    @staticmethod
    def _analysis_key(state: dict[str, Any]) -> dict[str, Any]:
        return {
            "chartType": state.get("chartType"),
            "yColumns": _unique_strings(state.get("yColumns")),
            "xAxisColumn": state.get("xAxisColumn"),
            "denominatorColumn": state.get("denominatorColumn"),
            "sampleSize": effective_sample_size(state),
            "ruleSet": state.get("ruleSet"),
        }

    @property
    def stale_fields(self) -> list[str]:
        """Analytical settings that differ from the setup the request's `processed` results were computed for."""
        original, current = self._analysis_key(self.original), self._analysis_key(self.current)
        return [field for field in ANALYTICAL_FIELDS if original[field] != current[field]]

    def current_controls(self) -> AgentControls:
        return AgentControls.model_validate({**self.current, "effectiveSampleSize": effective_sample_size(self.current)})

    def _stale_analysis(self) -> dict[str, Any]:
        return {
            "available": False,
            "analysisStale": True,
            "staleFields": self.stale_fields,
            "message": (
                "Settings changed in this turn. The app's earlier statistics describe the previous setup; it recalculates "
                "limits, rule signals, capability and diagnostics after the browser applies the patch. "
                "Quote none of the earlier numbers as current."
            ),
            "analyzedSettings": self._analysis_key(self.original),
        }

    def _record(self, name: str, args: dict[str, Any], result: dict[str, Any]) -> str:
        observation = compact_json(result, MAX_OBSERVATION_CHARS)
        trace_result: Any = result
        serialized = json.dumps(result, ensure_ascii=False, default=str)
        if len(serialized) > MAX_TRACE_RESULT_CHARS:
            trace_result = {"summary": _truncate(serialized, MAX_TRACE_RESULT_CHARS), "truncated": True}
        self.trace.append({"tool": name, "args": _compact(args), "result": trace_result})
        return observation

    def _current_snapshot(self) -> dict[str, Any]:
        current = {key: self.current.get(key) for key in EDITABLE_FIELDS if key in self.current}
        current["effectiveSampleSize"] = effective_sample_size(current)
        if current.get("ruleSet") is None:
            current.pop("ruleSet", None)
        return current

    def _snapshot(self) -> dict[str, Any]:
        current = self._current_snapshot()
        selected = _unique_strings(current.get("yColumns"))
        locked = current.get("chartType") in XBAR_CHART_TYPES and len(selected) > 1
        editable = [field for field in EDITABLE_FIELDS if field != "ruleSet" or self.original.get("ruleSet") is not None]
        numeric_headers = [name for name in self.headers if self._verify(name, "numeric") is True]
        unverified = self._unverified_headers()
        dataset = self.request.dataset
        stale = self._stale_analysis() if self.stale_fields else None
        return {
            "current": current,
            "available": {
                "chartTypes": sorted(AGENT_CHART_TYPES),
                "headers": self.headers[:MAX_HEADERS_IN_EVIDENCE],
                "numericHeaders": numeric_headers[:MAX_HEADERS_IN_EVIDENCE] if numeric_headers else None,
                "unverifiedHeaders": unverified[:MAX_HEADERS_IN_EVIDENCE] or None,
                "ruleSets": list(RULE_SETS) if self.original.get("ruleSet") is not None else None,
                "sampleSize": {
                    **sample_size_rule(current.get("chartType")),
                    "rule": describe_sample_size_rule(current.get("chartType")),
                    "current": current.get("sampleSize"),
                    "effective": current.get("effectiveSampleSize"),
                    "lockedToYColumns": locked,
                    "usedByChart": sample_size_is_used(current),
                },
                "editableFields": editable,
                "readOnly": {
                    "lowerSpecLimit": self.original.get("lowerSpecLimit"),
                    "upperSpecLimit": self.original.get("upperSpecLimit"),
                    "targetValue": self.original.get("targetValue"),
                },
            },
            "worksheet": _compact(self.request.worksheet),
            "assistant": {
                "language": self.request.language,
                "agentModeEnabled": True,
                "tools": [tool.name for tool in self.tool_metadata],
            },
            "dataset": _compact({
                "summary": _truncate(str(dataset.get("summary") or ""), 1500),
                "rowCount": dataset.get("rowCount"),
                "columnCount": dataset.get("columnCount"),
                "previewRows": _list(dataset.get("previewRows"))[:3],
            }, max_list=8, max_str=160),
            "processed": stale or self.evidence,
            "diagnostics": stale or self._diagnostics(),
        }

    def _diagnostics(self) -> dict[str, Any]:
        processed = _dict(self.request.processed)
        evidence = self.evidence
        return {
            "dataProfile": processed.get("dataProfile"),
            "diagnostics": evidence.get("diagnostics") or [],
            "chartRecommendations": evidence.get("candidates") or [],
            "capabilityStatus": evidence.get("capability"),
            "ruleViolationCount": processed.get("ruleViolationCount", 0),
            "ruleSummary": evidence.get("rules"),
            "variationRuleSummary": evidence.get("variationRules"),
            "controlLimits": evidence.get("limits"),
            "statistics": evidence.get("statistics"),
            "specLimits": _dict(evidence.get("capability")).get("specs"),
        }

    @staticmethod
    def _selected_sections(include: Any, allowed: tuple[str, ...]) -> tuple[list[str] | None, list[str]]:
        if include is None or include == [] or include == "":
            return None, []
        requested = [include] if isinstance(include, str) else [item for item in _list(include) if isinstance(item, str)]
        lowered = {name.lower(): name for name in allowed}
        selected = [lowered[item.strip().lower()] for item in requested if item.strip().lower() in lowered]
        unknown = [item for item in requested if item.strip().lower() not in lowered]
        return selected or None, unknown

    # -- tools -------------------------------------------------------------

    def list_tools(self, **_: Any) -> str:
        result = {
            "ok": True,
            "tool": "list-tools",
            "tools": [
                {"name": tool.name, "description": tool.description, "arguments": sorted(tool.parameters.get("properties", {}).keys())}
                for tool in self.tool_metadata
            ],
        }
        return self._record("list-tools", {}, result)

    def read_controls(self, include: Any = None, **extra: Any) -> str:
        snapshot = self._snapshot()
        selected, unknown = self._selected_sections(include, READ_CONTROLS_SECTIONS)
        sections = selected or ["current", "available", "worksheet"]
        result: dict[str, Any] = {"ok": True, "tool": "read_controls", "snapshot": {key: snapshot[key] for key in sections}}
        if unknown or extra:
            result["ignored"] = [*unknown, *extra.keys()]
        return self._record("read_controls", {"include": include}, result)

    def read_spc_diagnostics(self, include: Any = None, **extra: Any) -> str:
        selected, unknown = self._selected_sections(include, DIAGNOSTIC_SECTIONS)
        result: dict[str, Any] = {"ok": True, "tool": "read_spc_diagnostics"}
        if self.stale_fields:
            result.update(self._stale_analysis())
        else:
            diagnostics = self._diagnostics()
            result["available"] = bool(self.request.processed)
            result["diagnostics"] = {key: diagnostics[key] for key in selected} if selected else diagnostics
        if unknown or extra:
            result["ignored"] = [*unknown, *extra.keys()]
        return self._record("read_spc_diagnostics", {"include": include}, result)

    def update_controls(self, **kwargs: Any) -> str:
        self.update_calls += 1
        if self.update_calls > MAX_UPDATE_CALLS:
            result = {
                "ok": False,
                "tool": "update_controls",
                "error": f"Update limit reached ({MAX_UPDATE_CALLS} calls per turn). Nothing changed. Call finish and explain.",
                "patch": self.patch,
            }
            return self._record("update_controls", kwargs, result)

        call_rejected: list[dict[str, Any]] = []
        call_warnings: list[str] = []

        def reject(field: str, value: Any, reason: str) -> None:
            entry = {"field": field, "value": _compact(value, max_str=80), "reason": reason}
            call_rejected.append(entry)

        args: dict[str, Any] = {}
        for raw_key, value in kwargs.items():
            key = ARG_ALIASES.get(raw_key, raw_key)
            if key == "reason":
                self.reason = _clean_text(value, 300) or self.reason
                continue
            if key not in EDITABLE_FIELDS:
                if raw_key in {"lowerSpecLimit", "upperSpecLimit", "targetValue", "lsl", "usl", "target"}:
                    reject(raw_key, value, "Specification limits come from requirements; ask the user to enter them in the app.")
                else:
                    reject(raw_key, value, f"Unknown field. Editable fields: {', '.join(EDITABLE_FIELDS)}.")
                continue
            if key in args:
                continue
            args[key] = value

        proposed = dict(self.current)
        requested_fields = set(args)

        if "chartType" in args:
            chart_type = normalize_chart_type(args["chartType"])
            if chart_type is None:
                reject("chartType", args["chartType"], f"Unknown chart type. Use one of: {', '.join(sorted(AGENT_CHART_TYPES))}.")
            else:
                proposed["chartType"] = chart_type

        if "yColumns" in args:
            requested = coerce_column_list(args["yColumns"], self.headers)
            resolved: list[str] = []
            unknown: list[str] = []
            non_numeric: list[str] = []
            unverified: list[str] = []
            for column in requested:
                match = resolve_column(column, self.headers)
                if match is None:
                    unknown.append(column)
                    continue
                verdict = self._verify(match, "numeric")
                if verdict is not True:
                    (non_numeric if verdict is False else unverified).append(match)
                    continue
                if match not in resolved:
                    resolved.append(match)
            if resolved:
                proposed["yColumns"] = resolved
                if unknown:
                    call_warnings.append(f"Ignored unknown Y column(s): {', '.join(unknown)}.")
                if non_numeric:
                    call_warnings.append(f"Ignored non-numeric Y column(s): {', '.join(non_numeric)}.")
                if unverified:
                    call_warnings.append(f"Ignored Y column(s) not verified as numeric: {self._unverified_reason(unverified, 'numeric')}")
            elif non_numeric or unverified:
                reasons = [f"Column(s) {', '.join(non_numeric)} contain no numeric values."] if non_numeric else []
                if unverified:
                    reasons.append(self._unverified_reason(unverified, "numeric"))
                reject("yColumns", args["yColumns"], " ".join(reasons))
            else:
                reject("yColumns", args["yColumns"], f"No matching headers. Valid headers: {', '.join(self.headers[:30])}.")

        for field in ("xAxisColumn", "denominatorColumn"):
            if field not in args:
                continue
            value = args[field]
            if value is None or (isinstance(value, str) and value.strip().lower() in NONE_WORDS):
                proposed[field] = None
                continue
            match = resolve_column(value, self.headers)
            if match is None:
                reject(field, value, "Column not found in active-sheet headers.")
                continue
            if field == "denominatorColumn" and self._verify(match, "positive") is False:
                reject(field, value, "Denominator must be a numeric column with positive values (units or opportunities per row).")
                continue
            proposed[field] = match

        if "sampleSize" in args:
            # Range checks depend on the chart this update leaves in place; see _validate_setup.
            size = coerce_number(args["sampleSize"])
            if size is None:
                reject("sampleSize", args["sampleSize"], "Sample size must be a number.")
            else:
                proposed["sampleSize"] = size

        for field in TEXT_FIELDS:
            if field not in args or args[field] is None:
                continue
            cleaned = _clean_text(args[field])
            if cleaned is None:
                reject(field, args[field], "Label must be non-empty text.")
                continue
            if isinstance(args[field], str) and len(args[field].strip()) > MAX_LABEL_CHARS:
                call_warnings.append(f"{field} shortened to {MAX_LABEL_CHARS} characters.")
            proposed[field] = cleaned

        if "colorScheme" in args and args["colorScheme"] is not None:
            scheme = _clean_text(args["colorScheme"], 40)
            if scheme is None or not re.fullmatch(r"[A-Za-z0-9 _-]+", scheme):
                reject("colorScheme", args["colorScheme"], "Color scheme must be a short identifier such as 'default'.")
            else:
                proposed["colorScheme"] = scheme

        for field in BOOL_FIELDS:
            if field not in args:
                continue
            flag = coerce_bool(args[field])
            if flag is None:
                reject(field, args[field], "Expected true or false.")
            else:
                proposed[field] = flag

        if "ruleSet" in args:
            if self.original.get("ruleSet") is None:
                reject("ruleSet", args["ruleSet"], "This app version does not expose rule-set selection.")
            else:
                rule_set = normalize_rule_set(args["ruleSet"])
                if rule_set is None:
                    reject("ruleSet", args["ruleSet"], "Use 'nelson' (8 tests) or 'westernElectric' (4 rules).")
                else:
                    proposed["ruleSet"] = rule_set

        self._validate_setup(proposed, requested_fields, reject, call_warnings, {entry["field"] for entry in call_rejected})

        changed: list[str] = []
        unchanged: list[str] = []
        for field in EDITABLE_FIELDS:
            if proposed.get(field) == self.current.get(field):
                if field in requested_fields and field not in {entry["field"] for entry in call_rejected}:
                    unchanged.append(field)
                continue
            self.current[field] = proposed.get(field)
            changed.append(field)

        for entry in call_rejected:
            self.rejections[entry["field"]] = entry
        for field in changed:
            self.rejections.pop(field, None)
        self.warnings.extend(warning for warning in call_warnings if warning not in self.warnings)

        result: dict[str, Any] = {
            "ok": not call_rejected,
            "tool": "update_controls",
            "patch": self.patch,
            "applied": changed,
            "skipped": [entry["field"] for entry in call_rejected],
            "rejected": call_rejected,
            "unchanged": unchanged,
            "warnings": call_warnings,
            "current": self._current_snapshot(),
            "reason": self.reason,
        }
        if self.stale_fields:
            result["analysis"] = {
                "stale": True,
                "staleFields": self.stale_fields,
                "note": "The app's earlier statistics no longer describe this setup; it recalculates after the browser applies the patch. Do not quote earlier numbers as current.",
            }
        if call_rejected:
            result["hint"] = "Rejected fields were not changed. Fix them only if the user's request needs it; otherwise explain the rejection."
        return self._record("update_controls", kwargs, result)

    def _validate_setup(self, proposed: dict[str, Any], requested: set[str], reject: Any, warnings: list[str], already_rejected: set[str]) -> None:
        """Check chart type, Y, denominator and sample size together against the data.

        A setup that does not fit is never applied with just a warning: every fit field this call changes is
        rejected and the current analytical setup stays. Labels, overlays, and colors in the same call still apply.
        """
        fit_changed = [field for field in FIT_FIELDS if field in requested and proposed.get(field) != self.current.get(field)]
        notes: list[str] = []
        problems = self._setup_problems(proposed, requested, notes, mutate=bool(fit_changed))
        if fit_changed and problems:
            reason = " ".join(dict.fromkeys(text for _, text in problems))
            for field in fit_changed:
                if field not in already_rejected:
                    reject(field, proposed.get(field), reason)
            for field in FIT_FIELDS:
                proposed[field] = self.current.get(field)
            return
        if fit_changed:
            warnings.extend(notes)
            return
        refuted = list(dict.fromkeys(text for kind, text in problems if kind == "refuted"))
        if refuted:
            warnings.append(f"Current {proposed.get('chartType')} setup may not fit the data: {' '.join(refuted)}")

    def _setup_problems(self, state: dict[str, Any], requested: set[str], notes: list[str], mutate: bool) -> list[tuple[str, str]]:
        """Problems ("refuted" or "unverified") with an analytical setup; may normalize `state` when `mutate`."""
        problems: list[tuple[str, str]] = []
        chart_type = state.get("chartType")
        columns = _unique_strings(state.get("yColumns"))
        primary = columns[0] if columns else None

        def need(column: str, requirement: str, refuted_text: str, size: Any = None) -> None:
            verdict = self._verify(column, requirement, size)
            if verdict is False:
                problems.append(("refuted", refuted_text))
            elif verdict is None:
                problems.append(("unverified", self._unverified_reason([column], requirement)))

        if mutate and chart_type == "npChart" and state.get("denominatorColumn"):
            if "denominatorColumn" in requested:
                problems.append(("refuted", "NP charts use a constant subgroup size (sampleSize) and no denominator column; use a P chart when units vary."))
            else:
                # NP assumes a constant subgroup size; the app cannot compute it with a denominator column.
                state["denominatorColumn"] = None
                notes.append("denominatorColumn cleared because NP charts use a constant subgroup size (use a P chart for varying sizes).")
        denominator = state.get("denominatorColumn")
        if primary and denominator == primary:
            problems.append(("refuted", "Denominator column must differ from the Y column."))

        if primary and chart_type in ATTRIBUTE_CHART_TYPES:
            if chart_type == "pChart" and denominator:
                need(primary, "counts", f"P chart with a denominator needs non-negative integer counts in '{primary}'.")
                need(
                    denominator,
                    "positiveIntegers",
                    f"P chart denominators must be positive whole numbers (units inspected per row); '{denominator}' has fractional or non-positive values.",
                )
            elif chart_type == "pChart":
                need(primary, "proportions", f"P chart needs proportions between 0 and 1 in '{primary}', or a denominatorColumn with inspected units.")
            else:
                need(primary, "counts", f"{chart_type} needs non-negative integer counts in '{primary}'.")
                if chart_type == "uChart" and denominator:
                    need(denominator, "positive", f"U chart denominators must be positive; '{denominator}' has zero or negative values.")

        locked = chart_type in XBAR_CHART_TYPES and len(columns) > 1
        if locked:
            if len(columns) > SAMPLE_SIZE_MAX:
                problems.append(("refuted", f"X-bar charts support at most {SAMPLE_SIZE_MAX} subgroup columns."))
            elif mutate and state.get("sampleSize") != len(columns):
                if "sampleSize" in requested:
                    notes.append(f"sampleSize locked to {len(columns)}: with multiple Y columns each row is one subgroup.")
                state["sampleSize"] = len(columns)
        else:
            size_error = sample_size_error(state.get("sampleSize"), chart_type)
            if size_error and ("sampleSize" in requested or sample_size_is_used(state)):
                problems.append(("refuted", size_error + ("" if "sampleSize" in requested else " Pass sampleSize with this change.")))
            elif primary and chart_type == "npChart" and self._verify(primary, "counts") is True:
                profile = self._column_profile(primary) or {}
                need(
                    primary,
                    "maxAtMost",
                    f"NP counts in '{primary}' reach {_fmt(profile.get('max'))}, above subgroup size n={state.get('sampleSize')}; set sampleSize to the units inspected per row.",
                    state.get("sampleSize"),
                )

        if chart_type == "uChart" and not denominator:
            notes.append(f"U chart without a denominator treats each row as {state.get('sampleSize')} units; set denominatorColumn if units vary.")
        if not locked and chart_type in {"individual", "ewma", "pChart", "npChart", "cChart", "uChart"} and len(columns) > 1:
            notes.append(f"Only the first Y column ('{primary}') drives the {chart_type} limits.")
        return problems

    @property
    def patch(self) -> dict[str, Any]:
        changes = [
            {"field": field, "from": self.original.get(field), "to": self.current.get(field)}
            for field in EDITABLE_FIELDS
            if self.current.get(field) != self.original.get(field)
        ]
        rejected = [entry for field, entry in self.rejections.items()]
        if not changes and not rejected:
            return {}
        patch: dict[str, Any] = {change["field"]: change["to"] for change in changes}
        patch["applied"] = [change["field"] for change in changes]
        patch["skipped"] = [entry["field"] for entry in rejected]
        if self.reason:
            patch["reason"] = self.reason
        patch["changes"] = changes
        patch["rejected"] = rejected
        if self.warnings:
            patch["warnings"] = list(self.warnings)
        return patch

    @property
    def changes(self) -> list[dict[str, Any]]:
        return self.patch.get("changes", [])

    def dspy_tools(self) -> list[dspy.Tool]:
        functions = {
            "list-tools": self.list_tools,
            "read_controls": self.read_controls,
            "read_spc_diagnostics": self.read_spc_diagnostics,
            "update_controls": self.update_controls,
        }
        return [
            dspy.Tool(functions[tool.name], name=tool.name, desc=TOOL_DESCRIPTIONS[tool.name], args=MODEL_TOOL_ARGS[tool.name])
            for tool in self.tool_metadata
        ]


# ---------------------------------------------------------------------------
# Bounded ReAct
# ---------------------------------------------------------------------------


def is_context_window_error(error: BaseException) -> bool:
    context_error = getattr(litellm, "ContextWindowExceededError", None)
    if context_error is not None and isinstance(error, context_error):
        return True
    message = str(error).lower()
    return "context window" in message or "context length" in message or "maximum context" in message


def _short_error(error: BaseException, limit: int = 300) -> str:
    message = str(error).strip().splitlines()
    return _truncate(f"{type(error).__name__}: {message[0] if message else ''}", limit)


def _tool_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


class BoundedReAct(dspy.ReAct):
    """dspy.ReAct with limits suited to small models.

    Upstream ReAct stops only on ValueError, so a single AdapterParseError (a plain
    Exception) from a malformed step aborts the whole turn. This loop recovers once
    from a format error, tolerates tool-name paraphrases, stops repeated identical
    calls, keeps tool errors short, and honours a wall-clock deadline. Only parser
    errors are recovered: any other model error (including a bare ValueError) propagates.

    The deadline is checked before every model call and again when it returns: a reply that
    arrives after the budget is neither acted on nor treated as `finish`, and extraction is not
    started. Each call gets the remaining budget as its provider timeout.
    """

    # Starting a model call with less time than this left is pointless.
    MIN_CALL_SECONDS = 0.5

    def __init__(
        self,
        signature: Any,
        tools: list[Any],
        max_iters: int = 5,
        deadline_seconds: float | None = None,
        max_format_errors: int = 1,
        *,
        deadline_at: float | None = None,
        clock: Callable[[], float] | None = None,
        before_extract: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
    ) -> None:
        super().__init__(signature, tools=tools, max_iters=max_iters)
        # Accept any string and resolve it ourselves instead of failing the parse on "Update_Controls".
        self.react.signature = self.react.signature.with_updated_fields("next_tool_name", type_=str)
        self.deadline_seconds = deadline_seconds
        self.deadline_at = deadline_at
        self.clock = clock or time.monotonic
        self.before_extract = before_extract
        self.max_format_errors = max_format_errors
        self.stop_reason: str | None = None
        self.trajectory: dict[str, Any] = {}
        self._tool_lookup = {_tool_key(name): name for name in self.tools}

    def resolve_tool_name(self, raw: Any) -> str | None:
        if not isinstance(raw, str):
            return None
        candidate = raw.strip().strip("`'\"").split("(")[0].strip()
        return self._tool_lookup.get(_tool_key(candidate))

    def _format_hint(self) -> str:
        return (
            "FORMAT ERROR: your last reply could not be read. Reply with the fields next_thought, "
            f"next_tool_name (exactly one of: {', '.join(self.tools)}), and next_tool_args (a JSON object). "
            "Use finish when you have what you need."
        )

    def _remaining(self, deadline: float | None) -> float | None:
        return None if deadline is None else deadline - self.clock()

    def _timed_call(self, module: Any, trajectory: dict[str, Any], input_args: dict[str, Any], deadline: float | None) -> Any:
        args = dict(input_args)
        remaining = self._remaining(deadline)
        if remaining is not None:
            configured = getattr(getattr(dspy.settings, "lm", None), "kwargs", None) or {}
            timeout = configured.get("timeout") if isinstance(configured, dict) else None
            budget = remaining if _finite(timeout) is None or timeout <= 0 else min(float(timeout), remaining)
            args["config"] = {**_dict(args.get("config")), "timeout": max(budget, 0.001)}
        return self._call_with_potential_trajectory_truncation(module, trajectory, **args)

    def forward(self, **input_args: Any) -> dspy.Prediction:
        trajectory: dict[str, Any] = {}
        self.trajectory = trajectory
        max_iters = input_args.pop("max_iters", self.max_iters)
        if self.deadline_at is not None:
            deadline: float | None = self.deadline_at
        else:
            deadline = self.clock() + self.deadline_seconds if self.deadline_seconds else None

        def out_of_time(minimum: float = 0.0) -> bool:
            remaining = self._remaining(deadline)
            return remaining is not None and remaining <= minimum

        format_errors = 0
        repeats = 0
        seen_calls: Counter[tuple[str, str]] = Counter()
        self.stop_reason = "max_iters"

        for idx in range(max_iters):
            if out_of_time(self.MIN_CALL_SECONDS):
                self.stop_reason = "deadline"
                break
            try:
                pred = self._timed_call(self.react, trajectory, input_args, deadline)
            except AdapterParseError as err:
                if out_of_time():
                    self.stop_reason = "deadline"
                    break
                format_errors += 1
                logger.warning("ReAct step %s unparseable: %s", idx, _short_error(err))
                if format_errors > self.max_format_errors:
                    self.stop_reason = "format_error"
                    break
                trajectory[f"thought_{idx}"] = "(unreadable reply)"
                trajectory[f"tool_name_{idx}"] = "none"
                trajectory[f"tool_args_{idx}"] = {}
                trajectory[f"observation_{idx}"] = self._format_hint()
                continue
            except ValueError as err:
                # dspy raises ValueError when trajectory truncation cannot fit the context window;
                # any other ValueError is a real model/provider failure and must reach the caller.
                if is_context_window_error(err):
                    self.stop_reason = "context_window"
                    break
                raise

            if out_of_time():
                # The reply came back after the budget: neither run its tool nor accept its `finish`.
                self.stop_reason = "deadline"
                break

            tool_name = self.resolve_tool_name(pred.next_tool_name)
            tool_args = pred.next_tool_args if isinstance(pred.next_tool_args, dict) else {}
            trajectory[f"thought_{idx}"] = pred.next_thought
            trajectory[f"tool_name_{idx}"] = tool_name or pred.next_tool_name
            trajectory[f"tool_args_{idx}"] = tool_args

            if tool_name is None:
                format_errors += 1
                trajectory[f"observation_{idx}"] = f"Unknown tool {pred.next_tool_name!r}. Use one of: {', '.join(self.tools)}."
                if format_errors > self.max_format_errors:
                    self.stop_reason = "format_error"
                    break
                continue

            if tool_name == "finish":
                trajectory[f"observation_{idx}"] = "Completed."
                self.stop_reason = "finish"
                break

            call_key = (tool_name, json.dumps(tool_args, sort_keys=True, default=str))
            seen_calls[call_key] += 1
            if seen_calls[call_key] > 1:
                repeats += 1
                trajectory[f"observation_{idx}"] = "Repeated call with identical arguments; the result is already above. Call finish now."
                if repeats >= 2:
                    self.stop_reason = "repeated_calls"
                    break
                continue

            try:
                observation = self.tools[tool_name](**tool_args)
            except Exception as err:
                observation = f"ERROR in {tool_name}: {_short_error(err)}"
            trajectory[f"observation_{idx}"] = _truncate(str(observation), MAX_OBSERVATION_CHARS)

        if self.stop_reason == "deadline" or out_of_time(self.MIN_CALL_SECONDS):
            # No budget left for the final answer: the caller substitutes a deterministic one.
            self.stop_reason = "deadline"
            return dspy.Prediction(trajectory=trajectory, answer="", needs_clarification="false")
        extract_args = self.before_extract(dict(input_args)) if self.before_extract else input_args
        extract = self._timed_call(self.extract, trajectory, extract_args, deadline)
        return dspy.Prediction(trajectory=trajectory, **extract)


class SPCAgentDecision(dspy.Signature):
    """You are the SPC assistant inside a control-chart app. Help with user_request.

    Rules:
    1. Numbers: never calculate statistics. Quote only numbers that appear in `evidence` or tool results (computed by the app). If a number is not there, say it is not available.
    2. Settings change only through the update_controls tool, and only when the user asks for a change or task_hints says autopilot. Never say a setting changed unless update_controls listed it under "changes".
    3. Use exact header names from evidence. If the request is ambiguous or required data is missing, ask one short question instead of guessing.
    4. Control limits (UCL/LCL, from process data) are not specification limits (LSL/USL, from requirements). Never derive one from the other. You cannot set spec limits.
    5. When discussing rule numbers, name the rule set (Nelson 8 tests or Western Electric 4 rules).
    6. Answer in the requested language, short and practical (at most 5 bullets) unless the user asks for detail. For greetings or general questions just answer.
    7. Only if the user asks for an interactive or visual explanation: add one ```html block that is self-contained (inline CSS and JS only), uses no external URLs or network calls, and never accesses the app or parent page.
    """

    language: str = dspy.InputField(desc="Answer language code: en or he")
    conversation: str = dspy.InputField(desc="Earlier chat turns, oldest first")
    user_request: str = dspy.InputField(desc="Latest user message")
    evidence: str = dspy.InputField(desc="App-computed facts: settings, headers, data profile, limits, rule signals, capability")
    spc_knowledge: str = dspy.InputField(desc="Reference SPC notes")
    task_hints: str = dspy.InputField(desc="Hints about what the user wants")
    answer: str = dspy.OutputField(desc="Final user-facing answer in Markdown")
    needs_clarification: str = dspy.OutputField(desc="true only if the answer asks the user for missing information, else false")


TASK_HINT_TEXT = {
    "autopilot": "Autopilot: set up the most suitable chart with update_controls if the current setup is not already suitable, then summarize what changed and why.",
    "change": "The user may want chart settings changed; use update_controls for that.",
    "capability": "The user asks about capability; use the CAPABILITY evidence and its readiness. The app appends a capability table.",
    "rules": "The user asks about rule signals; use RULE SIGNALS evidence and name the rule set. The app appends a signal table.",
    "diagnostics": "The user asks about data diagnostics; use PROFILE, DIAGNOSTIC and CANDIDATE evidence.",
    "limits": "The user asks about control limits or sigma; use CONTROL LIMITS evidence.",
    "evidence": "The user wants the numbers; the app appends an evidence table, so interpret rather than repeat it.",
    "html": "The user wants an interactive explanation: include one self-contained ```html block.",
}

CLARIFICATION_FALLBACK = {
    "en": "- Please ask one specific SPC question.",
    "he": "- אנא שאל שאלת SPC אחת וממוקדת.",
}

APP_VERIFICATION_TRAILER_RE = re.compile(r"\[App verification:[^\]]*\]\s*$")
# Evidence tables the gateway appended to earlier answers; the current evidence input supersedes them.
APP_EVIDENCE_SECTION_RE = re.compile(r"\*\*(?:App-computed evidence|ראיות שחושבו באפליקציה)\*\*[\s\S]*$")

RECALCULATION_NOTICE = {
    "en": "_Settings changed in this turn: the app recalculates limits, rule signals and capability after applying them, so earlier results are not shown. Ask again afterwards for the updated numbers._",
    "he": "_ההגדרות שונו בתור זה: האפליקציה מחשבת מחדש גבולות, אותות חוקים ויכולת לאחר החלתן, ולכן התוצאות הקודמות אינן מוצגות. שאל שוב לאחר מכן לקבלת הערכים המעודכנים._",
}


class RequestTooLargeError(Exception):
    """The latest user message exceeds the hard limit. It is rejected, never silently truncated."""

    def __init__(self, length: int, limit: int) -> None:
        super().__init__(
            f"The latest message is {length} characters; the assistant accepts at most {limit}. "
            "Shorten it or split it into several messages. Nothing was sent to the model and no settings were changed."
        )
        self.length = length
        self.limit = limit


def latest_user_message(messages: list[ChatMessage]) -> str:
    for message in reversed(messages):
        if message.role == "user" and (message.content or "").strip():
            return (message.content or "").strip()
    return ""


def max_latest_request_chars() -> int:
    return env_int("DSPY_MAX_REQUEST_CHARS", DEFAULT_MAX_LATEST_REQUEST_CHARS, 1000, 200000)


def ensure_latest_request_size(messages: list[ChatMessage]) -> str:
    latest = latest_user_message(messages)
    limit = max_latest_request_chars()
    if len(latest) > limit:
        raise RequestTooLargeError(len(latest), limit)
    return latest


class SPCAgentHarness:
    def __init__(self, max_iters: int = 5, deadline_seconds: float | None = 90.0, clock: Callable[[], float] | None = None) -> None:
        self.max_iters = max_iters
        self.deadline_seconds = deadline_seconds
        self.clock = clock or time.monotonic
        self.tool_metadata = [
            ToolMetadata(
                name="list-tools",
                description="List available SPC agent tools with Markdown instructions and structured schemas.",
                parameters=TOOL_PARAMETER_SCHEMAS["list-tools"],
                markdown=TOOL_MARKDOWN["list-tools"],
            ),
            ToolMetadata(
                name="read_controls",
                description="Read current SPC controls, worksheet context, assistant settings, and allowed options.",
                parameters=TOOL_PARAMETER_SCHEMAS["read_controls"],
                markdown=TOOL_MARKDOWN["read_controls"],
            ),
            ToolMetadata(
                name="read_spc_diagnostics",
                description="Read app-computed SPC diagnostics, limits, rule signals, chart candidates, and capability.",
                parameters=TOOL_PARAMETER_SCHEMAS["read_spc_diagnostics"],
                markdown=TOOL_MARKDOWN["read_spc_diagnostics"],
            ),
            ToolMetadata(
                name="update_controls",
                description="Validate and propose SPC UI control changes as a browser-applyable patch.",
                parameters=TOOL_PARAMETER_SCHEMAS["update_controls"],
                markdown=TOOL_MARKDOWN["update_controls"],
            ),
        ]

    @classmethod
    def from_env(cls) -> SPCAgentHarness:
        return cls(
            max_iters=env_int("DSPY_AGENT_MAX_ITERS", 5, 1, 8),
            deadline_seconds=float(env_int("DSPY_AGENT_DEADLINE_SECONDS", 90, 10, 600)),
        )

    @staticmethod
    def _latest_user_request(messages: list[ChatMessage]) -> str:
        return latest_user_message(messages)

    @staticmethod
    def _message_context(messages: list[ChatMessage], limit: int = MAX_HISTORY_MESSAGES, per_message: int = MAX_HISTORY_MESSAGE_CHARS) -> str:
        """Earlier user/assistant turns, excluding system prompts and the latest user message."""
        history = [message for message in messages if message.role in {"user", "assistant"} and (message.content or "").strip()]
        if history and history[-1].role == "user":
            history = history[:-1]
        fragments = []
        for message in history[-limit:]:
            content = HTML_BLOCK_RE.sub("[interactive html example omitted]", (message.content or "").strip())
            # The frontend appends what the app actually verified; it must survive truncation.
            trailer_match = APP_VERIFICATION_TRAILER_RE.search(content)
            trailer = trailer_match.group(0).strip() if trailer_match else ""
            body = content[: trailer_match.start()].rstrip() if trailer_match else content
            body = APP_EVIDENCE_SECTION_RE.sub("[app evidence table omitted]", body)
            text = _truncate(body, max(200, per_message - len(trailer)))
            fragments.append(f"{message.role}: {text}{' ' + trailer if trailer else ''}")
        return "\n".join(fragments) or "(no earlier turns)"

    _parse_bool = staticmethod(_parse_bool)

    def _build_inputs(self, request: AgentTurnRequest, user_request: str, intents: list[str], evidence_text: str, knowledge: KnowledgeSelection, minimal: bool) -> dict[str, Any]:
        hints = [TASK_HINT_TEXT[intent] for intent in intents if intent in TASK_HINT_TEXT]
        if "change" not in intents:
            hints.append("No settings change was requested: answer without calling update_controls.")
        # The latest request is always sent in full (oversize requests are rejected up front);
        # the reduced-context retry trims only history, evidence, and knowledge.
        return {
            "language": request.language,
            "conversation": self._message_context(request.messages, limit=2 if minimal else MAX_HISTORY_MESSAGES, per_message=400 if minimal else MAX_HISTORY_MESSAGE_CHARS),
            "user_request": user_request,
            "evidence": _truncate(evidence_text, 2500 if minimal else 6000),
            "spc_knowledge": _truncate(CORE_SPC_KNOWLEDGE, 2500) if minimal else knowledge.markdown,
            "task_hints": " ".join(hints) or "Answer the question.",
        }

    @staticmethod
    def _pending_evidence(request: AgentTurnRequest, session: SPCAgentToolSession) -> dict[str, Any]:
        """Settings and dataset facts for the setup this turn leaves in place, with no (stale) statistics."""
        pending = request.model_copy(update={"controls": session.current_controls(), "processed": None})
        return build_spc_evidence(pending)

    def _extract_inputs(self, args: dict[str, Any], request: AgentTurnRequest, session: SPCAgentToolSession) -> dict[str, Any]:
        stale_fields = session.stale_fields
        if not stale_fields:
            return args
        args["evidence"] = evidence_prompt_text(self._pending_evidence(request, session), stale_fields=stale_fields)
        args["task_hints"] = (
            f"{args.get('task_hints') or ''} Settings changed in this turn: say what changed and that the app recalculates "
            "the results after applying; quote no earlier statistics."
        ).strip()
        return args

    @staticmethod
    def _reasoning(trajectory: Any) -> str | None:
        if not isinstance(trajectory, dict):
            return None
        thoughts = [str(value).strip() for key, value in trajectory.items() if key.startswith("thought_") and str(value).strip()]
        return _truncate("\n".join(thoughts), MAX_REASONING_CHARS) or None

    @staticmethod
    def _change_summary(session: SPCAgentToolSession, language: str) -> str:
        changes = session.changes
        if not changes:
            return ""
        def show(value: Any) -> str:
            if isinstance(value, list):
                return ", ".join(str(item) for item in value) or "none"
            return "none" if value is None else str(value)
        header = "השינויים שהוחלו (אומתו באפליקציה):" if language == "he" else "Applied changes (validated by the app):"
        return "\n".join([header, *(f"- {change['field']}: {show(change['from'])} → {show(change['to'])}" for change in changes)])

    def _fallback_answer(self, language: str, reason: str, session: SPCAgentToolSession) -> str:
        if language == "he":
            lead = f"- לא הצלחתי להשלים את ניתוח ה-AI הפעם ({reason})."
            no_change = "- לא שונו הגדרות תרשים."
        else:
            lead = f"- I couldn't complete the AI analysis this time ({reason})."
            no_change = "- No chart settings were changed."
        parts = [lead]
        summary = self._change_summary(session, language)
        parts.append(summary if summary else no_change)
        return "\n".join(parts)

    def _stale_replacement(self, session: SPCAgentToolSession, language: str) -> str:
        """Deterministic answer used when model prose quotes numbers the new settings have made stale."""
        lead = (
            "- עדכנתי את הגדרות התרשים; הניתוח הקודם כבר אינו תקף, ולכן אינני מצטט את מספריו."
            if language == "he"
            else "- I updated the chart settings; the earlier analysis no longer applies, so I am not quoting its numbers."
        )
        parts = [lead, self._change_summary(session, language)]
        rejected = session.patch.get("rejected") or []
        if rejected:
            parts.append("לא הוחל:" if language == "he" else "Not applied:")
            parts.extend(f"- {entry['field']}: {entry['reason']}" for entry in rejected)
        return "\n".join(part for part in parts if part)

    def run(self, request: AgentTurnRequest, knowledge: KnowledgeSelection, model_name: str) -> AgentTurnResponse:
        user_request = ensure_latest_request_size(request.messages)
        if not user_request:
            return AgentTurnResponse(
                content=CLARIFICATION_FALLBACK.get(request.language, CLARIFICATION_FALLBACK["en"]),
                controlPatch=None,
                toolTrace=[],
                knowledgeSources=knowledge.sources,
                needsClarification=True,
                model=model_name,
                usage={"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                status="clarification",
            )

        # One wall-clock budget for the whole turn, including the reduced-context retry.
        deadline_at = self.clock() + self.deadline_seconds if self.deadline_seconds else None
        intents = detect_intents(user_request)
        evidence = build_spc_evidence(request)
        evidence_text = evidence_prompt_text(evidence)
        sections = [] if "autopilot" in intents else evidence_sections_for(intents)
        language = request.language
        warnings: list[str] = []
        status: Literal["ok", "fallback", "clarification"] = "ok"
        answer = ""
        needs_clarification = False
        reasoning: str | None = None
        stop_reason: str | None = None

        with track_usage() as usage_tracker:
            for attempt, minimal in enumerate((False, True)):
                session = SPCAgentToolSession(request, self.tool_metadata, evidence)
                agent = BoundedReAct(
                    SPCAgentDecision,
                    tools=session.dspy_tools(),
                    max_iters=self.max_iters,
                    deadline_at=deadline_at,
                    clock=self.clock,
                    before_extract=lambda args, session=session: self._extract_inputs(args, request, session),
                )
                inputs = self._build_inputs(request, user_request, intents, evidence_text, knowledge, minimal)
                try:
                    prediction = agent(**inputs)
                    answer = clean_model_answer(getattr(prediction, "answer", ""))
                    needs_clarification = _parse_bool(getattr(prediction, "needs_clarification", False))
                    reasoning = self._reasoning(getattr(prediction, "trajectory", None))
                    stop_reason = agent.stop_reason
                    break
                except AdapterParseError as err:
                    # The final answer ignored the field format; small models usually still wrote one.
                    answer = clean_model_answer(rescue_answer_from_raw(getattr(err, "lm_response", "")))
                    reasoning = self._reasoning(agent.trajectory)
                    stop_reason = agent.stop_reason
                    warnings.append("answerFormatRecovered" if answer else "answerUnparseable")
                    break
                except Exception as err:
                    if is_context_window_error(err) and attempt == 0:
                        warnings.append("contextReduced")
                        continue
                    raise

        if stop_reason and stop_reason not in {"finish", "max_iters"}:
            warnings.append(f"agentStopped:{stop_reason}")

        stale_fields = session.stale_fields
        if not answer:
            status = "fallback"
            reason_text = {
                "deadline": "time limit reached" if language != "he" else "חריגה ממגבלת הזמן",
                "format_error": "the model reply could not be read" if language != "he" else "לא ניתן היה לקרוא את תשובת המודל",
                "context_window": "the request was too large for the model" if language != "he" else "הבקשה גדולה מדי עבור המודל",
            }.get(stop_reason or "", "the model returned no answer" if language != "he" else "המודל לא החזיר תשובה")
            answer = self._fallback_answer(language, reason_text, session)
            if not sections and evidence.get("available"):
                sections = ["limits", "rules", "capability"]
        elif "answerFormatRecovered" in warnings and session.changes:
            answer = f"{answer}\n\n{self._change_summary(session, language)}"

        answer, html_warnings = sanitize_html_blocks(answer, language)
        warnings.extend(html_warnings)
        if "html" in intents and not has_html_block(answer):
            # The app-built visual reads the request's analysis, which no longer matches changed settings.
            visual = None if stale_fields else deterministic_visual(request, intents, language)
            if visual:
                answer = f"{answer.strip()}\n\n{visual}".strip()
                warnings.append("htmlVisualFallback")
            else:
                warnings.append("htmlVisualUnavailable")

        notes: list[str] = []
        if not session.changes and CHANGE_CLAIM_RE.search(FENCED_BLOCK_RE.sub(" ", answer)):
            warnings.append("unverifiedChangeClaim")
            notes.append("_לא שונו הגדרות תרשים בתור זה._" if language == "he" else "_Note: no chart settings were changed in this turn._")

        user_texts = [message.content or "" for message in request.messages if message.role in {"user", "system"}]
        headers = list(request.availableHeaders)
        removed_numbers: list[str] = []
        if stale_fields:
            # The request's statistics describe the previous setup: only settings, dataset facts, user text,
            # and knowledge can ground numbers now.
            warnings.append("analysisStale")
            pending = self._pending_evidence(request, session)
            references = collect_reference_numbers(
                evidence["chart"],
                evidence["dataset"],
                pending["chart"],
                session.patch,
                _dict(request.dataset).get("previewRows"),
                user_texts,
                knowledge.markdown,
                CORE_SPC_KNOWLEDGE,
                [entry.get("result") for entry in session.trace if entry.get("tool") in {"update_controls", "list-tools"}],
            )
            ungrounded = find_ungrounded_numbers(answer, references, headers)
            if ungrounded:
                warnings.append("staleNumbersRemoved")
                removed_numbers, ungrounded = ungrounded, []
                answer = self._stale_replacement(session, language)
            notes.append(RECALCULATION_NOTICE.get(language, RECALCULATION_NOTICE["en"]))
            sections = []
            response_evidence: dict[str, Any] | None = {
                "available": False,
                "stale": True,
                "staleFields": stale_fields,
                "chart": pending["chart"],
                "analyzedChart": evidence["chart"],
            }
        else:
            references = collect_reference_numbers(
                evidence,
                evidence_text,
                request.processed,
                _dict(request.dataset).get("previewRows"),
                user_texts,
                knowledge.markdown,
                CORE_SPC_KNOWLEDGE,
                [entry.get("result") for entry in session.trace],
            )
            ungrounded = find_ungrounded_numbers(answer, references, headers)
            response_evidence = evidence if sections else None
        if ungrounded:
            warnings.append("ungroundedNumbers")
            listed = ", ".join(ungrounded)
            notes.append(
                f"_⚠️ הערכים {listed} אינם תואמים לתוצאות שחושבו באפליקציה; הסתמך על הערכים המחושבים._"
                if language == "he"
                else f"_⚠️ Check: {listed} do not match the app-computed results; rely on the app's values._"
            )

        content_parts = [answer.strip(), *notes]
        evidence_block = evidence_markdown(evidence, sections, language)
        if evidence_block:
            content_parts.append(evidence_block)
        content = "\n\n".join(part for part in content_parts if part)

        usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        try:
            for entry in usage_tracker.get_total_tokens().values():
                for key in usage:
                    usage[key] += int(entry.get(key) or 0)
        except Exception:
            pass

        patch = session.patch or None
        grounding: dict[str, Any] = {"checked": True, "ungroundedNumbers": ungrounded}
        if stale_fields:
            grounding.update({"analysisStale": True, "removedStaleNumbers": removed_numbers})
        return AgentTurnResponse(
            content=content,
            reasoning=reasoning,
            controlPatch=patch,
            toolTrace=session.trace,
            knowledgeSources=knowledge.sources,
            needsClarification=needs_clarification and status == "ok",
            model=model_name,
            usage=usage,
            status=status,
            intent=intents,
            warnings=warnings,
            evidence=response_evidence,
            grounding=grounding,
            stopReason=stop_reason,
        )


class AgentRecommendationHarness:
    @staticmethod
    def _clean_optional_text(value: object | None) -> str | None:
        if not isinstance(value, str):
            return None
        trimmed = value.strip()
        return trimmed or None

    @staticmethod
    def _clamp_sample_size(value: object | None) -> int | None:
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            return max(2, min(25, int(round(value))))
        if isinstance(value, str):
            match = re.search(r"\d+", value)
            if match:
                return max(2, min(25, int(match.group(0))))
        return None

    @staticmethod
    def _find_matching_brace_end(content: str, start: int) -> int | None:
        depth = 0
        in_string = False
        escape = False
        for index in range(start, len(content)):
            char = content[index]
            if in_string:
                if escape:
                    escape = False
                elif char == "\\":
                    escape = True
                elif char == '"':
                    in_string = False
                continue

            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    return index + 1
        return None

    @classmethod
    def _extract_json_objects(cls, content: str) -> list[dict[str, object]]:
        candidates: list[str] = []
        for match in re.finditer(r"```json\s*([\s\S]*?)```", content, flags=re.IGNORECASE):
            payload = match.group(1).strip()
            if payload:
                candidates.append(payload)

        for match in re.finditer(r"\{\s*\"recommendation\"\s*:", content):
            end = cls._find_matching_brace_end(content, match.start())
            if end is not None:
                candidates.append(content[match.start():end])

        parsed_candidates: list[dict[str, object]] = []
        seen: set[str] = set()
        for candidate in candidates:
            if candidate in seen:
                continue
            seen.add(candidate)
            try:
                parsed = json.loads(candidate)
            except Exception:
                continue
            if isinstance(parsed, dict):
                parsed_candidates.append(parsed)

        return parsed_candidates

    @classmethod
    def strip_structured_blocks(cls, content: str) -> str:
        stripped = re.sub(r"```json\s*[\s\S]*?```", "", content, flags=re.IGNORECASE)
        spans: list[tuple[int, int]] = []
        for match in re.finditer(r"\{\s*\"recommendation\"\s*:", stripped):
            end = cls._find_matching_brace_end(stripped, match.start())
            if end is not None:
                spans.append((match.start(), end))

        for start, end in reversed(spans):
            stripped = stripped[:start] + stripped[end:]

        stripped = re.sub(r"\n?\s*(?:json\s*)?\{[\s\S]*\"recommendation\"[\s\S]*$", "", stripped, flags=re.IGNORECASE)
        stripped = re.sub(r"(?im)^\s*json\s*$", "", stripped)
        return stripped.strip()

    @classmethod
    def _normalize_from_data(cls, data: dict[str, object]) -> AgentRecommendationModel:
        recommendation_raw = data.get("recommendation") if isinstance(data.get("recommendation"), dict) else {}
        recommendation_data = dict(recommendation_raw) if isinstance(recommendation_raw, dict) else {}

        y_columns_raw = recommendation_data.get("yColumns")
        if not isinstance(y_columns_raw, list):
            y_columns_raw = []
        y_columns: list[str] = []
        for value in y_columns_raw:
            if isinstance(value, str):
                trimmed = value.strip()
                if trimmed and trimmed not in y_columns:
                    y_columns.append(trimmed)

        y_column_legacy = cls._clean_optional_text(recommendation_data.get("yColumn"))
        if not y_columns and y_column_legacy:
            y_columns = [y_column_legacy]

        chart_type = normalize_chart_type(recommendation_data.get("chartType"))
        sample_size = cls._clamp_sample_size(recommendation_data.get("sampleSize"))
        x_axis_value = recommendation_data.get("xAxisColumn")
        x_axis_column = cls._clean_optional_text(x_axis_value)
        denominator_value = recommendation_data.get("denominatorColumn")
        denominator_column = cls._clean_optional_text(denominator_value)
        chart_label = cls._clean_optional_text(recommendation_data.get("chartLabel"))
        z_axis_label = cls._clean_optional_text(recommendation_data.get("zAxisLabel") or recommendation_data.get("xAxisLabel"))
        y_axis_label = cls._clean_optional_text(recommendation_data.get("yAxisLabel"))
        reason = cls._clean_optional_text(recommendation_data.get("reason")) or ""

        return AgentRecommendationModel(
            chartType=chart_type,
            yColumns=y_columns,
            yColumn=y_columns[0] if y_columns else y_column_legacy,
            xAxisColumn=x_axis_column,
            denominatorColumn=denominator_column,
            sampleSize=sample_size,
            chartLabel=chart_label,
            zAxisLabel=z_axis_label,
            yAxisLabel=y_axis_label,
            reason=reason,
        )

    @staticmethod
    def _score(model: AgentRecommendationModel) -> int:
        score = 0
        if model.chartType:
            score += 4
        score += min(len(model.yColumns), 8) * 3
        if model.xAxisColumn is not None:
            score += 1
        if model.denominatorColumn is not None:
            score += 2
        if model.sampleSize:
            score += 2
        if model.chartLabel:
            score += 1
        if model.zAxisLabel:
            score += 1
        if model.yAxisLabel:
            score += 1
        if model.reason:
            score += 1
        return score

    @staticmethod
    def _recover_chart_type(content: str) -> ChartTypeName | None:
        lowered = content.lower()
        chart_patterns: list[tuple[str, ChartTypeName]] = [
            (r"\bx\s*[- ]?\s*bar\s*s\b|\bxbar\s*s\b|\bx-bar\s*s\b", "xBarS"),
            (r"\bx\s*[- ]?\s*bar\s*r\b|\bxbar\s*r\b|\bx-bar\s*r\b", "xBarR"),
            (r"\bi\s*[- ]?\s*mr\b|\bindividual\b|\bi chart\b", "individual"),
            (r"\bu\s*chart\b|\bu-chart\b|defects per unit", "uChart"),
            (r"\bc\s*chart\b|\bc-chart\b|defect count", "cChart"),
            (r"\bnp\s*chart\b|\bnp-chart\b", "npChart"),
            (r"\bp\s*chart\b|\bp-chart\b|\bproportion\b", "pChart"),
            (r"\bewma\b", "ewma"),
            (r"\bhistogram\b", "histogram"),
            (r"\bscatter\s*plot\b", "scatterPlot"),
        ]
        for pattern, chart_type in chart_patterns:
            if re.search(pattern, lowered):
                return chart_type
        return None

    @staticmethod
    def _expand_column_range(prefix: str, start: str, end: str) -> list[str]:
        start_number = int(start)
        end_number = int(end)
        if end_number < start_number or end_number - start_number > 50:
            return []
        return [f"{prefix}{number}" for number in range(start_number, end_number + 1)]

    @classmethod
    def _recover_y_columns(cls, content: str) -> list[str]:
        columns: list[str] = []

        range_patterns = [
            r"\b([A-Za-z][A-Za-z0-9]*_)(\d+)\s*(?:through|to|-|–|—)\s*(?:[A-Za-z][A-Za-z0-9]*_)?(\d+)\b",
            r"\b([A-Za-z][A-Za-z0-9]*)(\d+)\s*(?:through|to|-|–|—)\s*(?:[A-Za-z][A-Za-z0-9]*)?(\d+)\b",
        ]
        for pattern in range_patterns:
            for match in re.finditer(pattern, content, flags=re.IGNORECASE):
                for column in cls._expand_column_range(match.group(1), match.group(2), match.group(3)):
                    if column not in columns:
                        columns.append(column)

        for match in re.finditer(r"\b[A-Za-z][A-Za-z0-9]*_\d+\b", content):
            column = match.group(0)
            if column not in columns:
                columns.append(column)

        return columns

    @classmethod
    def _recover_label(cls, content: str, names: tuple[str, ...]) -> str | None:
        joined = "|".join(re.escape(name) for name in names)
        pattern = rf"[\"']?(?:{joined})[\"']?\s*[:=]\s*[\"']?([^\"'\n\r]+)"
        match = re.search(pattern, content, flags=re.IGNORECASE)
        if not match:
            return None
        value = re.split(r"\s{2,}|[,;]|\.\s", match.group(1).strip(), maxsplit=1)[0].strip()
        return value or None

    @classmethod
    def _recover_from_narrative(cls, content: str) -> AgentRecommendationModel:
        chart_type = cls._recover_chart_type(content)
        y_columns = cls._recover_y_columns(content)
        sample_size = None

        sample_match = re.search(r"\b(?:sample|subgroup)\s*size\s*(?:of|=|:)?\s*(\d+)\b", content, flags=re.IGNORECASE)
        if sample_match:
            sample_size = cls._clamp_sample_size(sample_match.group(1))
        if sample_size is None and y_columns and chart_type in {"xBarS", "xBarR"}:
            sample_size = len(y_columns)

        chart_label = cls._recover_label(content, ("chartLabel", "chart label", "chart title"))
        z_axis_label = cls._recover_label(content, ("zAxisLabel", "xAxisLabel", "z axis label", "x axis label"))
        y_axis_label = cls._recover_label(content, ("yAxisLabel", "y axis label"))

        reason = ""
        reason_match = re.search(r"\breason\s*[:=]\s*([\s\S]+)$", content, flags=re.IGNORECASE)
        if reason_match:
            reason = re.sub(r"```json\s*[\s\S]*?```", "", reason_match.group(1), flags=re.IGNORECASE).strip()
            reason = reason.splitlines()[0].strip() if reason else ""
        if not reason and chart_type:
            bullets = [line.strip(" -\t") for line in content.splitlines() if line.strip().startswith(("-", "*"))]
            reason = bullets[0] if bullets else ""

        return AgentRecommendationModel(
            chartType=chart_type,
            yColumns=y_columns,
            yColumn=y_columns[0] if y_columns else None,
            xAxisColumn=None,
            denominatorColumn=None,
            sampleSize=sample_size,
            chartLabel=chart_label,
            zAxisLabel=z_axis_label,
            yAxisLabel=y_axis_label,
            reason=reason,
        )

    @classmethod
    def build_envelope(cls, content: str) -> AgentRecommendationEnvelope:
        models = [cls._normalize_from_data(candidate) for candidate in cls._extract_json_objects(content)]
        models.append(cls._recover_from_narrative(content))
        best = max(models, key=cls._score, default=AgentRecommendationModel())

        if best.sampleSize is None and best.chartType in {"xBarS", "xBarR"} and len(best.yColumns) > 1:
            best.sampleSize = len(best.yColumns)

        return AgentRecommendationEnvelope(recommendation=best)


class SPCConciseAdvice(dspy.Signature):
    """Provide concise, grounded SPC chart guidance.

    Rules:
    - Default style: at most 5 bullets, each 18 words or less, no preamble, no restating the prompt.
    - Quote statistics only from the context (the app's dataset summary); never calculate or invent numbers.
    - Control limits (from process data) are not specification limits (from requirements).
    - Name the rule set (Nelson 8 tests or Western Electric 4 rules) when discussing rule numbers.
    - If info is missing, include up to 2 short clarifying questions.
    - Only when the user asks for an interactive or visual explanation, you may add one self-contained ```html block (inline CSS/JS, no external URLs, no network calls, no access to the parent page).
    """

    language = dspy.InputField(desc="Language code: en or he")
    context = dspy.InputField(desc="Chat history and dataset context")
    user_request = dspy.InputField(desc="Latest user request")
    spc_knowledge = dspy.InputField(desc="Reference SPC notes")
    answer = dspy.OutputField(desc="Short, actionable SPC answer in Markdown")


# ---------------------------------------------------------------------------
# Gateway
# ---------------------------------------------------------------------------


def _exception_types(*names: str) -> tuple[type[BaseException], ...]:
    types: list[type[BaseException]] = []
    for name in names:
        candidate = getattr(litellm, name, None)
        if isinstance(candidate, type) and issubclass(candidate, BaseException):
            types.append(candidate)
    return tuple(types)


AUTH_ERRORS = _exception_types("AuthenticationError")
PERMISSION_ERRORS = _exception_types("PermissionDeniedError")
RATE_LIMIT_ERRORS = _exception_types("RateLimitError")
TIMEOUT_ERRORS = _exception_types("Timeout")
CONNECTION_ERRORS = _exception_types("APIConnectionError", "ServiceUnavailableError")
CONFIG_ERROR_MARKERS = ("Missing AI_API_KEY", "Missing AI_MODEL", "Missing AI_PROVIDER")
RATE_LIMIT_MARKERS = ("ratelimiterror", "rate limit", "429", "too many requests")
CONNECTIVITY_MARKERS = (
    "Connection error",
    "ConnectError",
    "APIConnectionError",
    "Temporary failure in name resolution",
    "Name or service not known",
    "Connection refused",
)
TIMEOUT_MARKERS = ("ReadTimeout", "timed out", "Timeout")


@dataclass(frozen=True)
class GatewayRuntime:
    """One request's handles. A concurrent .env reload swaps the gateway's attributes, never these."""

    lm: Any
    predictor: Any
    harness: SPCAgentHarness | None
    model_name: str | None
    lm_variants: dict[int, Any]


class DSPyGateway:
    def __init__(self) -> None:
        self._predictor: dspy.Predict | None = None
        self._agent_harness: SPCAgentHarness | None = None
        self._knowledge_loader = SPCKnowledgeLoader()
        self._model_name: str | None = None
        self._api_base: str | None = None
        self._env_mtime: float | None = None
        self._active_config: tuple[str, str | None, str, str | None] | None = None
        self._lm: dspy.LM | None = None
        self._lm_variants: dict[int, dspy.LM] = {}
        # Guards configuration state only; model calls run outside it.
        self._lock = threading.RLock()

    @staticmethod
    def _safe_api_base(api_base: str | None) -> str:
        if not api_base:
            return "(default)"
        parsed = urlparse(api_base)
        if not parsed.scheme or not parsed.netloc:
            return api_base
        return f"{parsed.scheme}://{parsed.netloc}"

    @staticmethod
    def _fallback_api_base() -> str | None:
        fallback = env_first("VITE_AI_API_URL")
        if not fallback:
            return None

        parsed = urlparse(fallback)
        if parsed.hostname in {"localhost", "127.0.0.1", "0.0.0.0"}:
            return None

        return fallback

    @staticmethod
    def _effective_api_base() -> str | None:
        return resolved_ai_config().api_base

    @staticmethod
    def _is_google_generative_api_base(api_base: str | None) -> bool:
        if not api_base:
            return False
        parsed = urlparse(api_base)
        return parsed.hostname == "generativelanguage.googleapis.com"

    @staticmethod
    def _normalize_api_base_for_provider(api_base: str | None, custom_llm_provider: str | None) -> str | None:
        if not api_base:
            return None

        parsed = urlparse(api_base)
        if custom_llm_provider == "gemini" and parsed.hostname == "generativelanguage.googleapis.com":
            return None

        return api_base

    @staticmethod
    def _gemini_model_name(model_name: str) -> str:
        return model_name if model_name.lower().startswith("gemini/") else f"gemini/{model_name}"

    @staticmethod
    def _resolve_litellm_target(model_name: str, api_base: str | None) -> tuple[str, str | None, str | None]:
        normalized = model_name.strip()
        if not normalized:
            return normalized, None, api_base

        lowered = normalized.lower()
        if lowered.startswith(KNOWN_PROVIDER_PREFIXES):
            provider_from_prefix = lowered.split("/", 1)[0]
            return normalized, None, DSPyGateway._normalize_api_base_for_provider(api_base, provider_from_prefix)

        provider = env_first("AI_PROVIDER")
        if provider:
            custom_provider = provider.strip().lower()
            if custom_provider == "gemini":
                return DSPyGateway._gemini_model_name(normalized), None, DSPyGateway._normalize_api_base_for_provider(api_base, custom_provider)
            return normalized, custom_provider, DSPyGateway._normalize_api_base_for_provider(api_base, custom_provider)

        if lowered.startswith("gemini-") or DSPyGateway._is_google_generative_api_base(api_base):
            return DSPyGateway._gemini_model_name(normalized), None, DSPyGateway._normalize_api_base_for_provider(api_base, "gemini")

        # Most self-hosted or gateway endpoints exposed via a custom base URL are
        # OpenAI-compatible, so default to LiteLLM's openai provider when a
        # provider-prefixed model name is not supplied.
        if api_base:
            return normalized, "openai", api_base

        return normalized, None, api_base

    def _reload_env_if_changed(self) -> None:
        with self._lock:
            try:
                mtime = ENV_PATH.stat().st_mtime
            except FileNotFoundError:
                mtime = None

            if mtime == self._env_mtime:
                return

            load_dotenv(dotenv_path=ENV_PATH, override=True)
            sync_managed_env_from_root()
            configure_combined_ca_bundle()
            self._env_mtime = mtime
            self._predictor = None
            self._agent_harness = None
            self._active_config = None
            self._model_name = None
            self._api_base = None
            self._lm = None
            self._lm_variants = {}

    def _configure(self) -> None:
        with self._lock:
            model_name, api_base, current_config, litellm_model_name, lm_kwargs = self._resolve_litellm_runtime()
            if self._predictor is not None and self._active_config == current_config:
                return

            # No dspy.configure(): DSPy only lets the first configuring thread change global
            # settings, and FastAPI runs sync handlers on a worker pool. Each call scopes the
            # LM with dspy.context() instead.
            # DSPy ignores endpoint/auth in cache keys; hot-swapped servers must get fresh requests.
            self._lm = dspy.LM(litellm_model_name, cache=False, **lm_kwargs)
            self._lm_variants = {}
            self._predictor = dspy.Predict(SPCConciseAdvice)
            self._agent_harness = SPCAgentHarness.from_env()
            self._model_name = model_name
            self._api_base = api_base
            self._active_config = current_config

    def _runtime(self) -> GatewayRuntime:
        """Configure if needed and capture a consistent set of handles for one request.

        Only this short section is serialized; the request then runs its upstream calls with the captured
        handles, so a hot reload in another thread cannot null them between the check and the call.
        """
        with self._lock:
            self._configure()
            return GatewayRuntime(
                lm=self._lm,
                predictor=self._predictor,
                harness=self._agent_harness,
                model_name=self._model_name,
                lm_variants=self._lm_variants,
            )

    def _lm_context(self, max_tokens: int | None = None, runtime: GatewayRuntime | None = None) -> Any:
        runtime = runtime or self._runtime()
        lm = runtime.lm
        if lm is not None and max_tokens is not None:
            # Reasoning models store the budget as max_completion_tokens.
            token_key = "max_completion_tokens" if "max_completion_tokens" in lm.kwargs else "max_tokens"
            if max_tokens > (lm.kwargs.get(token_key) or 0):
                variant = runtime.lm_variants.get(max_tokens)
                if variant is None:
                    variant = lm.copy(**{token_key: max_tokens})
                    runtime.lm_variants[max_tokens] = variant
                lm = variant
        adapter = dspy.ChatAdapter(use_json_adapter_fallback=env_flag("DSPY_JSON_ADAPTER_FALLBACK", False))
        return dspy.context(lm=lm, adapter=adapter)

    def _resolve_litellm_runtime(self) -> tuple[str, str | None, tuple[str, str | None, str, str | None], str, dict[str, object]]:
        self._reload_env_if_changed()

        config = resolved_ai_config()
        api_key, model_name, api_base = config.api_key, config.model, config.api_base
        if api_base and config.provider == "openai" and env_first("AI_API_URL"):
            # Canonical three-value mode treats the model ID literally, including vendor namespaces.
            litellm_model_name, custom_llm_provider = f"openai/{model_name or ''}", None
        else:
            litellm_model_name, custom_llm_provider, api_base = self._resolve_litellm_target(model_name or "", api_base)
        temperature = float(os.getenv("DSPY_TEMPERATURE", "0"))
        max_tokens = int(os.getenv("DSPY_MAX_TOKENS", "220"))
        timeout_seconds = float(os.getenv("DSPY_TIMEOUT_SECONDS", "20"))

        normalized_model_name = model_name.strip().lower() if model_name else ""
        lm_kwargs: dict[str, object] = {
            "max_tokens": max_tokens,
            "timeout": timeout_seconds,
        }
        if not normalized_model_name.startswith("gpt"):
            lm_kwargs["temperature"] = temperature
        if api_key:
            lm_kwargs["api_key"] = api_key
        if api_base:
            lm_kwargs["api_base"] = api_base
        if custom_llm_provider:
            lm_kwargs["custom_llm_provider"] = custom_llm_provider

        if not model_name:
            raise AIConfigurationError(
                "Missing AI_MODEL. "
                "Set it in project root .env before calling /v1/chat/completions."
            )

        if not api_key:
            raise AIConfigurationError(
                "Missing AI_API_KEY. "
                "Set it in project root .env before calling /v1/chat/completions."
            )

        if not api_base and not model_name.lower().startswith(KNOWN_PROVIDER_PREFIXES) and not config.provider:
            raise AIConfigurationError("Missing AI_API_URL. Set the upstream model endpoint alongside AI_API_KEY and AI_MODEL.")

        current_config = (model_name, api_base, api_key, custom_llm_provider)
        return model_name, api_base, current_config, litellm_model_name, lm_kwargs

    @staticmethod
    def _serialize_chat_message(message: ChatMessage) -> dict[str, object]:
        serialized: dict[str, object] = {
            "role": message.role,
            "content": message.content or "",
        }
        if message.tool_call_id:
            serialized["tool_call_id"] = message.tool_call_id
        if message.tool_calls:
            serialized["tool_calls"] = message.tool_calls
        return serialized

    @staticmethod
    def _normalize_completion_response(response: object) -> dict[str, object]:
        if isinstance(response, dict):
            return response
        if hasattr(response, "model_dump"):
            dumped = response.model_dump()
            if isinstance(dumped, dict):
                return dumped
        if hasattr(response, "dict"):
            dumped = response.dict()
            if isinstance(dumped, dict):
                return dumped
        raise RuntimeError("LiteLLM returned an unsupported completion payload")

    def complete_with_tools(self, payload: ChatCompletionRequest) -> dict[str, object]:
        _, api_base, current_config, litellm_model_name, completion_kwargs = self._resolve_litellm_runtime()
        model_name = current_config[0]
        with self._lock:
            self._model_name = model_name
            self._api_base = api_base
            self._active_config = current_config

        if payload.temperature is not None:
            completion_kwargs["temperature"] = payload.temperature
        if payload.max_tokens is not None:
            completion_kwargs["max_tokens"] = payload.max_tokens

        completion_kwargs.update({
            "model": litellm_model_name,
            "messages": [self._serialize_chat_message(message) for message in payload.messages],
            "stream": False,
        })
        if payload.tools:
            completion_kwargs["tools"] = [tool.model_dump(exclude_none=True) for tool in payload.tools]
        if payload.tool_choice is not None:
            completion_kwargs["tool_choice"] = payload.tool_choice

        response = litellm.completion(**completion_kwargs)
        return self._normalize_completion_response(response)

    def agent_turn(self, payload: AgentTurnRequest) -> dict[str, object]:
        # Size check first: an oversize request is rejected before configuration or any model call.
        latest = ensure_latest_request_size(payload.messages)
        runtime = self._runtime()
        if runtime.harness is None:
            raise RuntimeError("DSPy agent harness is not configured")

        knowledge = self._knowledge_loader.select(payload)
        model_name = runtime.model_name or "unknown"
        wants_html = "html" in detect_intents(latest)
        max_tokens = env_int("DSPY_HTML_MAX_TOKENS", 3000, 256, 16000) if wants_html else env_int("DSPY_AGENT_MAX_TOKENS", 1024, 128, 16000)
        with self._lm_context(max_tokens=max_tokens, runtime=runtime):
            response = runtime.harness.run(payload, knowledge, model_name)
        return response.model_dump()

    @staticmethod
    def _is_agent_mode_system_message(content: str | None) -> bool:
        lowered = (content or "").lower()
        return (
            "additional agent mode output requirement" in lowered
            or "agent mode is enabled" in lowered
            or "מצב agent" in lowered
            or "דרישת פלט נוספת במצב agent" in lowered
        )

    def _is_agent_mode(self, messages: list[ChatMessage]) -> bool:
        for message in messages:
            if message.role == "system" and self._is_agent_mode_system_message(message.content):
                return True

        for message in reversed(messages):
            if message.role != "user":
                continue
            lowered = (message.content or "").lower()
            if "agent mode is enabled" in lowered or "מצב agent" in lowered:
                return True
            break

        return False

    def _build_agent_envelope(self, content: str) -> AgentRecommendationEnvelope:
        return AgentRecommendationHarness.build_envelope(content)

    def _ensure_agent_mode_response(self, answer: str) -> str:
        envelope = self._build_agent_envelope(answer)
        json_block = json.dumps(envelope.model_dump(), ensure_ascii=False)
        narrative = AgentRecommendationHarness.strip_structured_blocks(answer)
        if not narrative:
            narrative = "- Applied agent recommendation to UI settings."
        return f"{narrative}\n\n```json\n{json_block}\n```"

    def answer(self, messages: list[ChatMessage]) -> str:
        latest_user = ensure_latest_request_size(messages)
        runtime = self._runtime()
        if runtime.predictor is None:
            raise RuntimeError("DSPy predictor is not configured")

        user_messages = [msg for msg in messages if msg.role == "user" and (msg.content or "").strip()]
        if not latest_user:
            return CLARIFICATION_FALLBACK["en"]

        language = "he" if re.search(r"[֐-׿]", latest_user) else "en"

        history_fragments: list[str] = []
        for msg in messages[-12:]:
            content = (msg.content or "").strip()
            if not content:
                continue
            if msg.role == "system" and not self._is_agent_mode_system_message(content):
                continue
            if msg is user_messages[-1]:
                continue
            content = HTML_BLOCK_RE.sub("[interactive html example omitted]", content)
            # The first user message usually carries the dataset summary; keep more of it.
            limit = 3000 if msg is user_messages[0] else MAX_HISTORY_MESSAGE_CHARS
            history_fragments.append(f"{msg.role}: {_truncate(content, limit)}")

        knowledge = self._knowledge_loader.select_for_text(
            "\n".join((msg.content or "")[:MAX_KNOWLEDGE_FOCUS_CHARS] for msg in user_messages[-3:]),
            budget=MAX_CHAT_KNOWLEDGE_CHARS,
        )
        wants_html = "html" in detect_intents(latest_user)
        context = "\n".join(history_fragments) or "(no earlier turns)"
        with self._lm_context(max_tokens=env_int("DSPY_HTML_MAX_TOKENS", 3000, 256, 16000) if wants_html else None, runtime=runtime):
            try:
                prediction = runtime.predictor(
                    language=language,
                    context=context,
                    user_request=latest_user,
                    spc_knowledge=knowledge.markdown,
                )
                answer = clean_model_answer(getattr(prediction, "answer", ""))
            except AdapterParseError as err:
                answer = clean_model_answer(rescue_answer_from_raw(getattr(err, "lm_response", "")))

        response = answer or "- No recommendation generated."
        response, _ = sanitize_html_blocks(response, language)
        if self._is_agent_mode(messages):
            return self._ensure_agent_mode_response(response)
        return response


def upstream_http_error(exc: Exception, operation: str) -> HTTPException:
    """Map provider/runtime failures to clear HTTP errors without leaking secrets."""
    if isinstance(exc, HTTPException):
        return exc
    if isinstance(exc, RequestTooLargeError):
        return HTTPException(status_code=413, detail=str(exc))
    if isinstance(exc, AIConfigurationError):
        return HTTPException(status_code=503, detail=str(exc))
    detail = str(exc) or f"DSPy {operation} failed"
    if any(marker in detail for marker in CONFIG_ERROR_MARKERS):
        return HTTPException(status_code=503, detail=detail)

    try:
        effective_base = gateway._effective_api_base()
    except AIConfigurationError:
        effective_base = None
    safe_base = gateway._safe_api_base(effective_base or gateway._api_base)
    model_name = env_first("AI_MODEL", "VITE_AI_MODEL") or gateway._model_name or "unknown"
    where = f"model={model_name}, api_base={safe_base}"
    lowered = detail.lower()

    if is_context_window_error(exc):
        return HTTPException(
            status_code=413,
            detail=f"The conversation and dataset context are too large for the model ({where}). Start a new chat or select fewer columns. Original error: {_truncate(detail, 400)}",
        )
    if (PERMISSION_ERRORS and isinstance(exc, PERMISSION_ERRORS)) or getattr(exc, "status_code", None) == 403:
        return HTTPException(
            status_code=502,
            detail="The API key does not have permission to use this model. Check model access or AI_MODEL.",
            headers={"X-SPC-Error-Code": "upstream_permission_denied"},
        )
    authentication_markers = ("authenticationerror", "authentication_error", "invalid api key", "incorrect api key", "invalid or expired api key", "expired api key", "invalid_token")
    if (AUTH_ERRORS and isinstance(exc, AUTH_ERRORS)) or getattr(exc, "status_code", None) == 401 or any(marker in lowered for marker in authentication_markers):
        return HTTPException(
            status_code=502,
            detail="The upstream API key is invalid or expired. Replace AI_API_KEY in the project .env file and try again.",
            headers={"X-SPC-Error-Code": "upstream_api_key_invalid"},
        )
    if (RATE_LIMIT_ERRORS and isinstance(exc, RATE_LIMIT_ERRORS)) or any(marker in lowered for marker in RATE_LIMIT_MARKERS):
        return HTTPException(
            status_code=429,
            detail=(
                f"DSPy upstream provider rate limited this {operation}. {where}. "
                "If you are using a free OpenRouter model, wait and retry, or switch to a different model. "
                f"Original error: {_truncate(detail, 400)}"
            ),
        )
    if (TIMEOUT_ERRORS and isinstance(exc, TIMEOUT_ERRORS)) or any(marker in detail for marker in TIMEOUT_MARKERS):
        return HTTPException(
            status_code=504,
            detail=f"DSPy upstream provider timed out during the {operation}. {where}. Original error: {_truncate(detail, 400)}",
        )
    if (CONNECTION_ERRORS and isinstance(exc, CONNECTION_ERRORS)) or any(marker in detail for marker in CONNECTIVITY_MARKERS):
        return HTTPException(
            status_code=503,
            detail=(
                f"DSPy upstream connection failed during the {operation}. {where}. "
                "Verify the upstream provider base URL is reachable and matches the configured model/provider. "
                f"Original error: {_truncate(detail, 400)}"
            ),
        )
    return HTTPException(status_code=500, detail=f"DSPy {operation} failed: {_truncate(detail, 600)}")


def require_gateway_key(authorization: str | None) -> None:
    required_gateway_key = env_first("AI_GATEWAY_API_KEY", "DSPY_GATEWAY_API_KEY") or DEFAULT_GATEWAY_API_KEY
    if not required_gateway_key:
        return
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if not hmac.compare_digest(token.encode("utf-8"), required_gateway_key.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Invalid API key")


app = FastAPI(title="SPC DSPy Gateway", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    expose_headers=["X-SPC-Error-Code"],
    allow_methods=["*"],
    allow_headers=["*"],
)

gateway = DSPyGateway()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/ready")
def health_ready() -> dict[str, object]:
    knowledge_docs = gateway._knowledge_loader.document_count()
    try:
        with gateway._lock:
            gateway._reload_env_if_changed()
            config = resolved_ai_config()
    except AIConfigurationError as exc:
        return {"ready": False, "reason": str(exc), "knowledge_docs": knowledge_docs}
    model_name, api_base = config.model or "", config.api_base or ""
    if not model_name:
        return {"ready": False, "reason": "Missing AI_MODEL", "model_source": "AI_MODEL"}
    if not config.api_key:
        return {"ready": False, "reason": "Missing AI_API_KEY", "model_source": "AI_MODEL"}
    if not api_base:
        if not model_name.lower().startswith(KNOWN_PROVIDER_PREFIXES) and not config.provider:
            return {"ready": False, "reason": "Missing AI_API_URL", "model_source": "AI_MODEL"}
        return {"ready": True, "model": model_name, "api_base": "(provider default)", "model_source": "AI_MODEL", "knowledge_docs": knowledge_docs}

    parsed = urlparse(api_base)
    host = parsed.hostname
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if not host:
        return {"ready": False, "reason": "Invalid AI_API_BASE", "api_base": api_base}

    try:
        with socket.create_connection((host, port), timeout=2):
            pass
    except Exception as exc:
        return {
            "ready": False,
            "reason": "Upstream host unreachable",
            "model": model_name,
            "api_base": f"{parsed.scheme}://{parsed.netloc}",
            "model_source": "AI_MODEL",
            "error": str(exc),
        }

    return {
        "ready": True,
        "model": model_name,
        "api_base": f"{parsed.scheme}://{parsed.netloc}",
        "model_source": "AI_MODEL",
        "knowledge_docs": knowledge_docs,
    }


@app.post("/v1/agent/turn")
def agent_turn(
    payload: AgentTurnRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, object]:
    require_gateway_key(authorization)
    try:
        return gateway.agent_turn(payload)
    except Exception as exc:  # pragma: no cover
        if not isinstance(exc, (HTTPException, RequestTooLargeError, AIConfigurationError) + AUTH_ERRORS + PERMISSION_ERRORS):
            logger.exception("Agent turn failed")
        raise upstream_http_error(exc, "agent request") from exc


@app.post("/v1/chat/completions")
def chat_completions(
    payload: ChatCompletionRequest,
    authorization: str | None = Header(default=None),
) -> dict[str, object]:
    require_gateway_key(authorization)

    tool_enabled_request = bool(payload.tools) or any(message.role == "tool" or message.tool_calls for message in payload.messages)

    if tool_enabled_request and payload.stream:
        raise HTTPException(status_code=400, detail="Tool-enabled requests currently require stream=false")

    try:
        if tool_enabled_request:
            return gateway.complete_with_tools(payload)

        content = gateway.answer(payload.messages)
    except Exception as exc:  # pragma: no cover
        if not isinstance(exc, (HTTPException, RequestTooLargeError) + AUTH_ERRORS + PERMISSION_ERRORS):
            logger.exception("Chat completion failed")
        raise upstream_http_error(exc, "request") from exc

    created = int(time.time())
    response_model = env_first("AI_MODEL", "VITE_AI_MODEL") or "unknown"

    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": created,
        "model": response_model,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": content,
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
    }


@app.get("/config/runtime-config.js", include_in_schema=False)
def serve_runtime_config() -> Response:
    return runtime_config_response()


@app.get("/", include_in_schema=False)
def serve_frontend_root() -> FileResponse:
    return frontend_index_response()


@app.get("/{asset_path:path}", include_in_schema=False)
def serve_frontend_asset(asset_path: str) -> FileResponse:
    reserved_prefixes = ("v1/", "health", "docs", "openapi.json", "redoc")
    if asset_path.startswith(reserved_prefixes):
        raise HTTPException(status_code=404, detail="Not found")

    asset_response = frontend_file_response(asset_path)
    if asset_response is not None:
        return asset_response

    if "." in Path(asset_path).name:
        raise HTTPException(status_code=404, detail="Static asset not found")

    return frontend_index_response()


if __name__ == "__main__":
    import uvicorn

    gateway_port_value = env_first("AI_GATEWAY_PORT", "DSPY_GATEWAY_PORT") or str(DEFAULT_GATEWAY_PORT)

    try:
        gateway_port = int(gateway_port_value)
    except ValueError as exc:
        raise RuntimeError("Invalid AI_GATEWAY_PORT. It must be an integer.") from exc

    reload_value = (os.getenv("DSPY_GATEWAY_RELOAD") or "true").strip().lower()
    reload_enabled = reload_value in {"1", "true", "yes", "on"}

    uvicorn.run("main:app", host="0.0.0.0", port=gateway_port, reload=reload_enabled)
