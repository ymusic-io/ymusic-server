#!/usr/bin/env node
// Signs an app installer for publishing — run on the PUBLISHER's machine, never on the server.
//
//   YM_UPDATE_SIGNING_KEY=<base64 PKCS#8 P-256 key> \
//     node scripts/sign-app-update.mjs <platform> <versionCode> <versionName> <installer> <public url> [notes file]
//
// <platform> is a RELEASES key: android, macos-arm64, macos-x64, windows-x64, linux-x64.
// Prints the entry for src/routes/config.ts. The signature is ECDSA P-256 / SHA-256 (DER, base64)
// over "app-<platform>:<versionCode>:<sha256 hex of the installer>" — what the desktop app rebuilds
// from the bytes it downloads. This key is the UPDATE key, not the JS bundle key.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'

const PLATFORMS = ['android', 'macos-arm64', 'macos-x64', 'windows-x64', 'linux-x64']

const [platform, versionCodeArg, versionName, file, url, notesFile] = process.argv.slice(2)
if (!PLATFORMS.includes(platform) || !versionCodeArg || !versionName || !file || !url) {
  console.error(
    `usage: sign-app-update.mjs <${PLATFORMS.join('|')}> <versionCode> <versionName> <installer> <public url> [notes file]`,
  )
  process.exit(2)
}
const versionCode = Number(versionCodeArg)
if (!Number.isSafeInteger(versionCode) || versionCode <= 0) {
  console.error(`versionCode must be a positive integer, got ${versionCodeArg}`)
  process.exit(2)
}
const keyBase64 = process.env.YM_UPDATE_SIGNING_KEY
if (!keyBase64) {
  console.error('YM_UPDATE_SIGNING_KEY is not set (base64 PKCS#8, e.g. update.private.key)')
  process.exit(2)
}

const privateKey = createPrivateKey({ key: Buffer.from(keyBase64, 'base64'), format: 'der', type: 'pkcs8' })
if (privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
  console.error('the signing key is not a P-256 key')
  process.exit(2)
}

// Streamed: an installer is a few hundred MB.
const hash = createHash('sha256')
for await (const chunk of createReadStream(file)) hash.update(chunk)
const sha256 = hash.digest('hex')
const message = Buffer.from(`app-${platform}:${versionCode}:${sha256}`, 'utf8')
const signature = sign('sha256', message, privateKey)

// Self-check with the public half, so a bad key never reaches config.ts.
const publicKey = createPublicKey(privateKey)
if (!verify('sha256', message, publicKey, signature)) {
  console.error('signature failed its own verification')
  process.exit(1)
}

const notes = notesFile ? readFileSync(notesFile, 'utf8').trim() : ''
console.error(`signed ${platform} ${versionName} (${versionCode}) sha256=${sha256}`)
console.error(`public key: ${publicKey.export({ format: 'der', type: 'spki' }).toString('base64')}`)
console.log(
  JSON.stringify(
    { versionCode, versionName, notes, url, size: statSync(file).size, sha256, signature: signature.toString('base64') },
    null,
    2,
  ),
)
