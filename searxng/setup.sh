#!/usr/bin/env bash
# Creates a random secret (once) and starts SearXNG on http://127.0.0.1:8888
cd "$(dirname "$0")" || exit 1
[ -f .env ] || echo "SEARXNG_SECRET=$(openssl rand -hex 32)" > .env
docker compose up -d
