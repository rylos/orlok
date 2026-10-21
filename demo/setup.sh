#!/usr/bin/env bash
# Starts the demo (demo/compose.yaml) and fills it with fresh fictional data (demo/seed): the
# database is dropped and created again every time, so run it before each round of screens.
#
#   demo/setup.sh            # reuse the orlok:demo image
#   demo/setup.sh --build    # build orlok:demo from this checkout first (after app changes)
#
# The first run writes random secrets to demo/.env (never committed, never printed).
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  {
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)"
    echo "ORLOK_SECRET_KEY=$(openssl rand -base64 32)"
    echo "ORLOK_RUNNER_TOKEN=$(openssl rand -hex 24)"
  } >.env
fi
set -a
. ./.env
set +a

compose() { docker compose --env-file .env "$@"; }

if [ "${1:-}" = "--build" ]; then
  compose build app
fi
compose stop app >/dev/null 2>&1 || true
compose up -d --wait db runner
compose exec -T db psql -U orlok -d postgres -q \
  -c "drop database if exists orlok_demo with (force)" -c "create database orlok_demo"
compose up -d app
for _ in $(seq 1 60); do
  curl -sf http://127.0.0.1:3999/api/health >/dev/null && break
  sleep 2
done

# Through the environment, not arguments: pnpm echoes the command line.
DATABASE_URL="postgres://orlok:${POSTGRES_PASSWORD}@127.0.0.1:5544/orlok_demo" \
  pnpm --filter @orlok/demo-seed --silent seed --paths ../screenshots/paths.json
