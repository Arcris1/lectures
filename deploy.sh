#!/usr/bin/env bash
# Rebuild the site from the markdown in this repo and restart the container.
# Safe to re-run. Requires only Docker — Node runs in a throwaway container.
set -euo pipefail
cd "$(dirname "$0")"

echo "── pull ──"
git pull --ff-only

echo "── build (node in a container, as the current user) ──"
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$PWD":/w -w /w \
  node:22-alpine node build-viewer.mjs

echo "── up ──"
docker compose up -d

echo "── verify ──"
sleep 2
docker compose ps --format '  {{.Name}}  {{.Status}}'
curl -s -o /dev/null -w "  local: %{http_code}\n" http://localhost/healthz 2>/dev/null || true
echo "done."
