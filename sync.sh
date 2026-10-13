#!/usr/bin/env bash
# Ship the committed tree (HEAD) to the server. Uncommitted changes and gitignored files
# (.env, tls/, node_modules, dist) stay here; the server restores its secrets with ./decrypt.sh,
# then builds and (re)starts with scripts/reload_api.sh.
set -euo pipefail
cd "$(dirname "$0")"

env_value() { sed -n "s/^$1=//p" dev.env 2>/dev/null || true; }
SERVER_IP=$(env_value SYNC_SERVER_IP)
KEY=$(env_value SYNC_SSH_KEY)
[[ -n $SERVER_IP && -n $KEY ]] || { echo "set SYNC_SERVER_IP and SYNC_SSH_KEY in dev.env" >&2; exit 1; }
HOST=root@$SERVER_IP
KEY=${KEY/#\~/$HOME}
DIR=/srv/ymusic-server

[[ -z $(git status --porcelain --untracked-files=no) ]] || echo "note: uncommitted changes are not shipped" >&2
git archive --format=tar HEAD |
  ssh -i "$KEY" "$HOST" "mkdir -p $DIR && chmod 700 $DIR && tar -xf - -C $DIR --no-same-owner"
echo "synced $(git rev-parse --short HEAD) → $HOST:$DIR"
