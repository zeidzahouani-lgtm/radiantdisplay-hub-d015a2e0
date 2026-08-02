#!/usr/bin/env bash
set -euo pipefail

APP_PORT="${APP_PORT:-8080}"
BIND_HOST="${BIND_HOST:-0.0.0.0}"
IMAGE_NAME="${IMAGE_NAME:-screenflow-local}"
CONTAINER_NAME="${CONTAINER_NAME:-screenflow-local}"

if [ ! -f .env.local ] && [ ! -f .env ]; then
  echo "Erreur: créez .env.local depuis .env.example avant le build." >&2
  exit 1
fi

node scripts/diagnose-local.mjs
npm run build:local

PUBLIC_APP_URL="${VITE_PUBLIC_APP_URL:-$(grep -E '^VITE_PUBLIC_APP_URL=' .env.local .env 2>/dev/null | tail -1 | cut -d= -f2-)}"
PUBLIC_APP_URL="${PUBLIC_APP_URL:-http://127.0.0.1:${APP_PORT}}"
APP_BASE_PATH="${VITE_APP_BASE_PATH:-$(grep -E '^VITE_APP_BASE_PATH=' .env.local .env 2>/dev/null | tail -1 | cut -d= -f2-)}"
APP_BASE_PATH="${APP_BASE_PATH:-/}"

docker build \
  --build-arg VITE_SUPABASE_URL="${VITE_SUPABASE_URL:-$(grep -E '^VITE_SUPABASE_URL=' .env.local .env 2>/dev/null | tail -1 | cut -d= -f2-)}" \
  --build-arg VITE_SUPABASE_PUBLISHABLE_KEY="${VITE_SUPABASE_PUBLISHABLE_KEY:-$(grep -E '^VITE_SUPABASE_PUBLISHABLE_KEY=' .env.local .env 2>/dev/null | tail -1 | cut -d= -f2-)}" \
  --build-arg VITE_SUPABASE_PROJECT_ID="${VITE_SUPABASE_PROJECT_ID:-$(grep -E '^VITE_SUPABASE_PROJECT_ID=' .env.local .env 2>/dev/null | tail -1 | cut -d= -f2-)}" \
  --build-arg VITE_PUBLIC_APP_URL="$PUBLIC_APP_URL" \
  --build-arg VITE_APP_BASE_PATH="$APP_BASE_PATH" \
  -t "$IMAGE_NAME" .

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER_NAME" --restart unless-stopped \
  --add-host host.docker.internal:host-gateway \
  -p "$BIND_HOST:$APP_PORT:80" "$IMAGE_NAME"

echo "Déploiement local terminé: ${PUBLIC_APP_URL}"
