#!/usr/bin/env bash
# Rebuild the site from the markdown in this repo and restart the container.
# Safe to re-run. Requires only Docker — Node runs in a throwaway container.
set -euo pipefail
cd "$(dirname "$0")"

SITE="https://lineaix.com"

echo "-- pull --"
git pull --ff-only

echo "-- build (node in a container, as the current user) --"
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$PWD":/w -w /w \
  node:22-alpine node build-viewer.mjs

echo "-- up --"
docker compose up -d

echo "-- verify --"
sleep 3
docker compose ps --format '  {{.Name}}  {{.Status}}'

# Check the container itself. NOT http://localhost/healthz from the host --
# that reaches Caddy on :80 and 308-redirects, never touching nginx.
docker exec lectures-web-1 wget -qO- --timeout=5 http://localhost/healthz \
  | sed 's/^/  container: /'

# `up -d` recreates the container, which changes its IP. Caddy re-resolves
# named upstreams per request so this normally just works -- but verify the
# public URL rather than assuming, and reload Caddy if it does not.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$SITE" || echo 000)
echo "  public:    $code"

if [ "$code" != "200" ]; then
  echo "  !! not serving -- reloading Caddy"
  docker exec ruined-your-friendships-caddy-1 \
    caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || true
  sleep 5
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$SITE" || echo 000)
  echo "  after reload: $code"
  [ "$code" = "200" ] || echo "  !! still failing -- try: docker compose -f ~/apps/ruined-your-friendships/docker-compose.prod.yml restart caddy"
fi

echo "done."
