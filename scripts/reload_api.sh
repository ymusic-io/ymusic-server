#!/bin/bash
# Build and (re)start the API (ymusic-server) and the dashboard (ymusic-dashboard) under pm2:
# start on first run, zero-downtime reload after. Both read .env (DASHBOARD_* for the dashboard).
#
#   scripts/reload_api.sh          reload
#   scripts/reload_api.sh force    restart
#
# Reads .env + tls/ restored by ./decrypt.sh. Node loads .env itself (--env-file) at every
# process start, so a reload picks up an edited .env.

set -e
set -x

cd "$(dirname "$0")/.."

export NODE_ENV=production

for f in .env tls/ca.crt tls/client-local.crt tls/client-local.key \
  tls/api.ymix.io.crt tls/api.ymix.io.key tls/dashboard.ymix.io.crt tls/dashboard.ymix.io.key; do
  if [ ! -f "$f" ]; then
    echo "File $f not found! Run ./decrypt.sh first."
    exit 1
  fi
done

npm ci --omit=dev
npm run build

cmd="reload"
if [[ $1 == "force" ]]; then
  cmd="restart"
fi

# name, entry, instances
deploy() {
  if pm2 describe "$1" >/dev/null; then
    pm2 $cmd "$1" --update-env
  else
    pm2 start "$2" -i "$3" --time --name="$1" --node-args="--env-file=.env" \
      --listen-timeout 15000 --kill-timeout 15000 --no-pmx
  fi
}

deploy ymusic-server dist/index.js 2
deploy ymusic-dashboard dist/dashboard/index.js 1

pm2 save
