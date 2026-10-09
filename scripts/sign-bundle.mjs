#!/usr/bin/env node
// Signs a JS bundle for publishing — run on the PUBLISHER's machine, never on the server.
//
//   YM_BUNDLE_SIGNING_KEY=<base64 PKCS#8 P-256 key> \
//     node scripts/sign-bundle.mjs <engine|player> <version> <bundle file> <public url>
//
// Prints the {version, url, signature} entry for src/routes/config.ts. The signature is ECDSA
// P-256 / SHA-256 (DER, base64) over "<name>:<version>:<sha256 hex of the file>" — exactly what the
// app's verifyBundleSignature rebuilds from the bytes it downloads.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'

const [name, versionArg, file, url] = process.argv.slice(2)
if (!['engine', 'player'].includes(name) || !versionArg || !file || !url) {
  console.error('usage: sign-bundle.mjs <engine|player> <version> <bundle file> <public url>')
  process.exit(2)
}
const version = Number(versionArg)
if (!Number.isSafeInteger(version) || version <= 0) {
  console.error(`version must be a positive integer, got ${versionArg}`)
  process.exit(2)
}
const keyBase64 = process.env.YM_BUNDLE_SIGNING_KEY
if (!keyBase64) {
  console.error('YM_BUNDLE_SIGNING_KEY is not set (base64 PKCS#8, e.g. bundle.signing.private.key)')
  process.exit(2)
}

const privateKey = createPrivateKey({ key: Buffer.from(keyBase64, 'base64'), format: 'der', type: 'pkcs8' })
if (privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
  console.error('the signing key is not a P-256 key')
  process.exit(2)
}
const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex')
const message = Buffer.from(`${name}:${version}:${sha256}`, 'utf8')
const signature = sign('sha256', message, privateKey)

// Self-check with the public half, so a bad key never reaches config.ts.
const publicKey = createPublicKey(privateKey)
if (!verify('sha256', message, publicKey, signature)) {
  console.error('signature failed its own verification')
  process.exit(1)
}

console.error(`signed ${name} v${version} sha256=${sha256}`)
console.error(`public key: ${publicKey.export({ format: 'der', type: 'spki' }).toString('base64')}`)
console.log(JSON.stringify({ version, url, signature: signature.toString('base64') }, null, 2))
