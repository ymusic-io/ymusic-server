#!/usr/bin/env bash
# Seal the server's secrets into secrets.enc — the one file that is committed and shipped; the
# server runs decrypt.sh to restore them. The DB client cert comes from ymusic-docker-configs/tls.
#
#   ./encrypt.sh        prompts for the passphrase (twice)
#
# AES-256-CBC, key from PBKDF2-HMAC-SHA512 at 1,000,000 iterations with a random salt. The
# plaintext carries its own SHA-256, checked by decrypt.sh before anything is written, so a wrong
# passphrase or a tampered file is refused rather than restored.
set -euo pipefail
cd "$(dirname "$0")"

FILES=(.env tls/ca.crt tls/client-local.crt tls/client-local.key)
OUT=secrets.enc
ITER=1000000

for f in "${FILES[@]}"; do
  [[ -f $f ]] || { echo "missing $f" >&2; exit 1; }
done

read -rsp "Passphrase: " passphrase; echo
read -rsp "Again: " again; echo
[[ $passphrase == "$again" ]] || { echo "passphrases differ" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# ustar, and no macOS metadata: GNU tar on the server extracts it without xattr noise.
COPYFILE_DISABLE=1 tar --format=ustar -cf "$work/payload.tar" "${FILES[@]}"
sum=$(openssl dgst -sha256 -r "$work/payload.tar" | cut -d' ' -f1)

{ echo "$sum"; cat "$work/payload.tar"; } |
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter "$ITER" -md sha512 -pass fd:3 \
    -out "$OUT.tmp" 3< <(printf '%s\n' "$passphrase")
mv "$OUT.tmp" "$OUT"
echo "sealed ${FILES[*]} → $OUT"
