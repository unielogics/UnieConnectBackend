#!/bin/bash
set -e

APP_DIR="/var/www/unie-backend"
REPO="https://github.com/unielogics/UnieConnectBackend.git"
BRANCH="main"
LOCK_FILE="/tmp/unieconnect-backend-deploy.lock"

exec 9>"$LOCK_FILE"
if ! flock -w 600 9; then
  echo "Timed out waiting for another backend deployment to finish."
  exit 1
fi

echo "Deploying repository $REPO (branch $BRANCH) to $APP_DIR"

NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v//;s/\..*//')
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node 20+ required on EC2. Current: $(node -v 2>/dev/null || echo missing)"
  exit 1
fi

mkdir -p "$APP_DIR"
cd "$APP_DIR"

if [ -d ".git" ]; then
  git remote set-url origin "$REPO" || git remote add origin "$REPO"
  git fetch --all
  git reset --hard origin/$BRANCH
else
  rm -rf ./*
  git init
  git remote add origin "$REPO"
  git fetch
  git reset --hard origin/$BRANCH
fi

npm ci --include=dev || npm install --include=dev
npm run build
npm prune --omit=dev || true
pm2 reload ecosystem.config.js || pm2 start ecosystem.config.js
pm2 save

for attempt in $(seq 1 20); do
  if curl --fail --silent --show-error http://127.0.0.1:4000/api/v1/ready >/dev/null; then
    echo "UnieConnect backend is ready."
    exit 0
  fi
  sleep 1
done

echo "Backend readiness check failed after deployment."
pm2 logs unieconnect-backend --err --lines 80 --nostream || true
exit 1
