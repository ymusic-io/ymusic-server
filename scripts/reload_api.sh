#!/bin/bash
# Build and (re)start the API (ymusic-server), the dashboard (ymusic-dashboard) and the SponsorBlock
# sync (ymusic-sb-sync) under pm2:
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

# name, entry, extra pm2 start args
deploy() {
  local name=$1 entry=$2
  shift 2
  if pm2 describe "$name" >/dev/null; then
    pm2 $cmd "$name" --update-env
  else
    pm2 start "$entry" "$@" --time --name="$name" --node-args="--env-file=.env" \
      --listen-timeout 15000 --kill-timeout 15000 --no-pmx
  fi
}

# The API runs in cluster mode (-i). The dashboard runs in fork mode (no -i) on purpose: pm2's
# cluster master shares one socket per port across ALL cluster apps, so a dashboard in cluster mode
# on the API's port silently joins its round-robin instead of failing with EADDRINUSE.
deploy ymusic-server dist/index.js -i 2
deploy ymusic-dashboard dist/dashboard/index.js
# One downloader for both API workers (fork mode); they read what it leaves in YM_SB_DIR.
deploy ymusic-sb-sync dist/sponsorBlock/sync.js

pm2 save
