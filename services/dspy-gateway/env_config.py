"""Resolve upstream AI configuration without reading global process state."""
from __future__ import annotations

from dataclasses import dataclass, field
from ipaddress import ip_address
from typing import Mapping
from urllib.parse import urlsplit, urlunsplit


@dataclass(frozen=True)
class AIConfig:
    # Avoid exposing the key in logs or exception diagnostics via repr(config).
    api_key: str | None = field(repr=False)
    api_base: str | None
    model: str | None
    provider: str | None


KNOWN_PROVIDERS = frozenset({
    "openai", "azure", "anthropic", "bedrock", "cohere", "gemini", "vertex_ai",
    "groq", "mistral", "ollama", "together_ai", "huggingface", "replicate",
    "deepseek", "xai",
})


def _first(environ: Mapping[str, str], *names: str) -> str | None:
    for name in names:
        value = environ.get(name, "").strip()
        if value:
            return value
    return None


def normalize_endpoint(endpoint: str, gateway_port: int | None = None) -> str:
    """Convert an OpenAI server/base/completion URL to its /v1 API base.

    Paths before /v1 are retained. Credentials, query strings and fragments are
    rejected to avoid ambiguous routing and inadvertent disclosure in errors.
    """
    try:
        parsed = urlsplit(endpoint.strip())
        host, port = parsed.hostname, parsed.port
    except ValueError as exc:
        raise ValueError("Invalid AI_API_URL: provide an HTTP(S) upstream URL with a valid host and port.") from exc
    if (parsed.scheme.lower() not in {"http", "https"} or not host or
            parsed.username is not None or parsed.password is not None or
            parsed.query or parsed.fragment or any(c.isspace() for c in endpoint)):
        raise ValueError("Invalid AI_API_URL: use an HTTP(S) upstream URL without credentials, query, or fragment.")

    local = host.lower() in {"localhost", "localhost.localdomain"}
    try:
        address = ip_address(host)
        local = local or address.is_loopback or address.is_unspecified
    except ValueError:
        pass
    effective_port = port or (443 if parsed.scheme.lower() == "https" else 80)
    if gateway_port is not None and local and effective_port == gateway_port:
        raise ValueError("AI_API_URL points to this gateway (self-loop). Set AI_API_URL to the upstream model server, not the gateway.")

    path = parsed.path.rstrip("/")
    suffix = "/v1/chat/completions"
    if path.endswith(suffix):
        path = path[:-len("/chat/completions")]
    elif not path.endswith("/v1"):
        path += "/v1"
    return urlunsplit((parsed.scheme.lower(), parsed.netloc, path, "", ""))


def resolve_ai_config(environ: Mapping[str, str], gateway_port: int | None = None) -> AIConfig:
    """Resolve canonical names first, then legacy names; missing values are None.

    Provider-prefixed legacy models are preserved. Explicit AI_PROVIDER wins;
    otherwise a recognized prefix is used, or openai for a custom endpoint.
    Callers should report missing fields according to their own context.
    """
    api_key = _first(environ, "AI_API_KEY", "DSPY_API_KEY", "OPENAI_API_KEY", "VITE_AI_API_KEY")
    model = _first(environ, "AI_MODEL", "VITE_AI_MODEL")
    endpoint = _first(environ, "AI_API_URL", "AI_API_BASE", "DSPY_API_BASE", "VITE_AI_API_URL")
    api_base = normalize_endpoint(endpoint, gateway_port) if endpoint else None
    provider = _first(environ, "AI_PROVIDER")
    if provider:
        provider = provider.lower()
    elif model and "/" in model and model.split("/", 1)[0].lower() in KNOWN_PROVIDERS:
        provider = model.split("/", 1)[0].lower()
    elif api_base:
        provider = "openai"
    return AIConfig(api_key=api_key, api_base=api_base, model=model, provider=provider)
