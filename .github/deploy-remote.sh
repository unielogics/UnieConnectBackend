#!/bin/bash
set -euo pipefail

APP_DIR="/var/www/unie-backend"
RELEASES_DIR="/var/www/unie-backend-releases"
CURRENT_LINK="/var/www/unie-backend-current"
REPO="https://github.com/unielogics/UnieConnectBackend.git"
BRANCH="main"
LOCK_FILE="/tmp/unieconnect-backend-deploy.lock"

exec 9>"$LOCK_FILE"
if ! flock -w 600 9; then
  echo "Timed out waiting for another backend deployment to finish."
  exit 1
fi

echo "Preparing repository $REPO (branch $BRANCH)"

NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v//;s/\..*//')
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node 20+ required on EC2. Current: $(node -v 2>/dev/null || echo missing)"
  exit 1
fi

mkdir -p "$APP_DIR" "$RELEASES_DIR"
cd "$APP_DIR"

if [ -d ".git" ]; then
  git remote set-url origin "$REPO" || git remote add origin "$REPO"
  git fetch --all
  git reset --hard origin/$BRANCH
else
  git init
  git remote add origin "$REPO"
  git fetch
  git reset --hard origin/$BRANCH
fi

COMMIT=$(git rev-parse --short=12 HEAD)
RELEASE_DIR="$RELEASES_DIR/$(date -u +%Y%m%d%H%M%S)-$COMMIT"
OLD_RELEASE=$(pm2 jlist 2>/dev/null | node -e '
  let body = "";
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => {
    try {
      const app = JSON.parse(body).find((item) => item.name === "unieconnect-backend");
      process.stdout.write(app?.pm2_env?.pm_cwd || "");
    } catch (_) {
      process.stdout.write("");
    }
  });
')
OLD_RELEASE=${OLD_RELEASE:-$APP_DIR}

echo "Building release $RELEASE_DIR while $OLD_RELEASE remains live"
mkdir -p "$RELEASE_DIR"
git archive HEAD | tar -x -C "$RELEASE_DIR"
if [ -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env" "$RELEASE_DIR/.env"
else
  echo "Production environment file $APP_DIR/.env is missing."
  exit 1
fi

cd "$RELEASE_DIR"
npm ci --include=dev
npm run build
npm prune --omit=dev

echo "Switching PM2 to release $COMMIT"
pm2 startOrReload "$RELEASE_DIR/ecosystem.config.js" --update-env

for attempt in $(seq 1 20); do
  if curl --fail --silent --show-error http://127.0.0.1:4000/api/v1/ready >/dev/null; then
    ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
    pm2 save
    find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
      | sort -nr \
      | tail -n +6 \
      | cut -d' ' -f2- \
      | while IFS= read -r old_release; do
          [ -n "$old_release" ] && [ "$old_release" != "$RELEASE_DIR" ] && rm -rf -- "$old_release"
        done
    echo "UnieConnect backend is ready."
    exit 0
  fi
  sleep 1
done

echo "Backend readiness check failed after deployment."
pm2 logs unieconnect-backend --err --lines 80 --nostream || true
if [ -f "$OLD_RELEASE/ecosystem.config.js" ]; then
  echo "Rolling back to $OLD_RELEASE"
  pm2 startOrReload "$OLD_RELEASE/ecosystem.config.js" --update-env || true
fi
exit 1
