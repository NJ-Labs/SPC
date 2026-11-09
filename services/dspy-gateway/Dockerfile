FROM ghcr.io/astral-sh/uv:0.7.3 AS uv

FROM python:3.12-slim

ARG PIP_INDEX_URL
ARG PIP_EXTRA_INDEX_URL
ARG PIP_TRUSTED_HOST

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SPC_DEFAULT_CA_BUNDLE=/app/certs/bluecoat-ca-bundle.pem \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    UV_CACHE_DIR=/tmp/.cache/uv

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY certs/bluecoat-ca-bundle.pem /app/certs/bluecoat-ca-bundle.pem
RUN cp /app/certs/bluecoat-ca-bundle.pem /usr/local/share/ca-certificates/spc-bluecoat-ca.crt \
    && update-ca-certificates

COPY --from=uv /uv /uvx /bin/

COPY pyproject.toml ./pyproject.toml
COPY uv.lock ./uv.lock
COPY README.md ./README.md
RUN set -eux; \
    if [ -n "${PIP_INDEX_URL:-}" ]; then export UV_INDEX_URL="$PIP_INDEX_URL"; fi; \
    if [ -n "${PIP_EXTRA_INDEX_URL:-}" ]; then export UV_EXTRA_INDEX_URL="$PIP_EXTRA_INDEX_URL"; fi; \
    if [ -n "${PIP_TRUSTED_HOST:-}" ]; then export UV_INSECURE_HOST="$PIP_TRUSTED_HOST"; fi; \
    uv sync --frozen --no-dev --no-install-project

COPY main.py spc_visuals.py env_config.py ./

EXPOSE 8001
CMD ["/app/.venv/bin/python", "main.py"]
