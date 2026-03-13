#!/bin/bash
set -e

APP_DIR="/var/www/unie-backend"
REPO="https://github.com/unielogics/UnieConnectBackend.git"
BRANCH="main"

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

npm ci || npm install
npm run build
npm prune --production || true
pm2 reload ecosystem.config.js || pm2 start ecosystem.config.js
pm2 save
