#!/bin/bash
# Build and (re)start the server under pm2: start on first run, zero-downtime reload after.
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

for f in .env tls/ca.crt tls/client-local.crt tls/client-local.key; do
  if [ ! -f "$f" ]; then
    echo "File $f not found! Run ./decrypt.sh first."
    exit 1
  fi
done

npm ci --omit=dev
npm run build

appName=ymusic-server

pm2 describe $appName >/dev/null && RUNNING=0 || RUNNING=1

if [ "${RUNNING}" -ne 0 ]; then
  pm2 start dist/index.js -i 2 --time --name=$appName --node-args="--env-file=.env" \
    --listen-timeout 15000 --kill-timeout 15000 --no-pmx
else
  cmd="reload"
  if [[ $1 == "force" ]]; then
    cmd="restart"
  fi

  pm2 $cmd $appName --update-env
fi

pm2 save
