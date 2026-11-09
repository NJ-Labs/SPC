#!/usr/bin/env bash
set -euo pipefail
spc_skip_node=false
spc_force=false
spc_docker=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-node-check) spc_skip_node=true ;;
    --force) spc_force=true ;;
    --docker) spc_docker=true ;;
    --help|-h)
      echo 'Usage: ./setup.sh [--skip-node-check] [--force] [--docker]'
      echo 'Installs locked npm and Python dependencies, then checks types, tests, and build.'
      echo 'Requires Node.js 22.13+ (24 LTS recommended), npm, and uv.'
      echo '--force refreshes downloads while preserving the lockfiles.'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done
spc_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$spc_root"
for spc_command in node npm uv; do
  if ! command -v "$spc_command" >/dev/null 2>&1; then
    echo "$spc_command is required. See SETUP.md for installation instructions." >&2
    exit 1
  fi
done
if [[ "$spc_skip_node" == false ]]; then
  node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (!((major === 22 && minor >= 13) || major === 24 || major >= 26)) { console.error('Use Node.js 22.13+, 24 LTS, or 26+.'); process.exit(1); }"
fi
echo 'Installing frontend dependencies from package-lock.json...'
if [[ "$spc_force" == true ]]; then npm ci --prefer-online; else npm ci; fi
echo 'Installing the gateway dependencies (uv manages Python 3.12)...'
uv sync --frozen --python 3.12 --project services/dspy-gateway
npm run typecheck
npm test
npm run build
if [[ "$spc_docker" == true ]]; then
  docker build -t spc-analysis-tool:local .
  echo 'Run locally: docker run --rm -p 8080:8080 spc-analysis-tool:local'
fi
echo 'Setup complete. Configure AI_API_KEY, AI_API_URL, and AI_MODEL in .env, then run npm run dev.'
