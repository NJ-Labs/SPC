FROM node:24-alpine AS web-build
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci

COPY . .

ENV NODE_ENV=production
RUN npm run build

FROM ghcr.io/astral-sh/uv:0.7.3 AS uv

FROM python:3.12-slim AS runtime

ARG PIP_INDEX_URL
ARG PIP_EXTRA_INDEX_URL
ARG PIP_TRUSTED_HOST

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
      PYTHONUNBUFFERED=1 \
      AI_GATEWAY_PORT=8080 \
      DSPY_GATEWAY_RELOAD=false \
      SPC_WEB_DIST_DIR=/app/spc-web-dist \
      SPC_DEFAULT_CA_BUNDLE=/app/certs/bluecoat-ca-bundle.pem \
      UV_LINK_MODE=copy \
      UV_PROJECT_ENVIRONMENT=/app/.venv \
      HOME=/tmp \
      XDG_CACHE_HOME=/tmp/.cache \
      UV_CACHE_DIR=/tmp/.cache/uv

RUN apt-get update \
      && apt-get install -y --no-install-recommends ca-certificates \
      && rm -rf /var/lib/apt/lists/*

COPY deploy/docker/certs/bluecoat-ca-bundle.pem /app/certs/bluecoat-ca-bundle.pem
RUN cp /app/certs/bluecoat-ca-bundle.pem /usr/local/share/ca-certificates/spc-bluecoat-ca.crt \
      && update-ca-certificates

COPY --from=uv /uv /uvx /bin/

COPY services/dspy-gateway/pyproject.toml ./pyproject.toml
COPY services/dspy-gateway/uv.lock ./uv.lock
COPY services/dspy-gateway/README.md ./README.md
RUN set -eux; \
      if [ -n "${PIP_INDEX_URL:-}" ]; then export UV_INDEX_URL="$PIP_INDEX_URL"; fi; \
      if [ -n "${PIP_EXTRA_INDEX_URL:-}" ]; then export UV_EXTRA_INDEX_URL="$PIP_EXTRA_INDEX_URL"; fi; \
      if [ -n "${PIP_TRUSTED_HOST:-}" ]; then export UV_INSECURE_HOST="$PIP_TRUSTED_HOST"; fi; \
      uv sync --frozen --no-dev --no-install-project

COPY services/dspy-gateway/main.py services/dspy-gateway/spc_visuals.py services/dspy-gateway/env_config.py ./
COPY docs/knowledge ./knowledge
COPY --from=web-build /workspace/dist ./spc-web-dist

RUN useradd --create-home --uid 10001 spc \
      && mkdir -p /tmp/.cache \
      && chown -R spc:spc /app /tmp

EXPOSE 8080

USER spc

HEALTHCHECK --interval=30s --timeout=3s CMD ["/app/.venv/bin/python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).read()"]

LABEL org.opencontainers.image.source="https://github.com/NaveDanan/SPC" \
        org.opencontainers.image.description="SPC-web with embedded DSPy gateway" \
        org.opencontainers.image.licenses="Apache-2.0"

CMD ["/app/.venv/bin/python", "main.py"]

