import type { FastifyInstance } from 'fastify'
import { header } from '../headers.js'

/**
 * A published app build. `sha256` is of the installer at `url` (APK, DMG, MSI or DEB); `signature`
 * is ECDSA P-256 over `app-<platform>:<versionCode>:<sha256>`, made OFFLINE with
 * `scripts/sign-app-update.mjs` — the desktop app installs nothing without it. Offered to builds
 * whose x-app-ver is below `versionCode`.
 */
export interface AppRelease {
  versionCode: number
  versionName: string
  notes: string
  url: string
  size: number
  sha256: string
  signature: string
}

/**
 * The newest build per platform, null while none is published. Desktop keys carry the arch
 * (x-arch); Android's APK is universal. Paste `scripts/sign-app-update.mjs` output here.
 */
export const RELEASES: Record<string, AppRelease | null> = {
  android: null,
  'macos-arm64': null,
  'macos-x64': null,
  'windows-x64': null,
  'linux-x64': null,
}

/** `android`, or `<os>-<arch>` for desktop. */
function platformOf(os: string, arch: string): string {
  return os === 'android' || arch === '' ? os : `${os}-${arch}`
}

/**
 * A published JS bundle. `signature` authenticates the file at `url` for `version`: ECDSA P-256 over
 * `<name>:<version>:<sha256 hex of the file>`, made OFFLINE with `scripts/sign-bundle.mjs` — the
 * signing key never reaches this server. The app refuses any bundle whose bytes do not match.
 */
export interface SignedBundle {
  version: number
  url: string
  signature: string
}

/**
 * The newest JS bundles, or null while none is published. Not per-platform: both run in QuickJS
 * everywhere. The client compares the version against the one it already has, so bumping these is
 * what ships a fix without a release: engine.js goes live at once, player.js at the next player
 * session. Paste `scripts/sign-bundle.mjs` output here.
 */
const ENGINE_JS: SignedBundle | null = null
const PLAYER_JS: SignedBundle | null = null

/**
 * What the app asks for at startup: feature flags, the newest JS bundles, and whether a newer build
 * exists.
 *
 * No cache headers on purpose — caching is the reverse proxy's job, and a Cache-Control set here
 * would override whatever it decides.
 */
export default async function configRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/config', (req) => {
    // The common context — os, arch, appVer, device uuid — rides as headers on every API call;
    // this route reads all but the uuid. Fastify lowercases header names.
    const os = (header(req.headers['x-os']) ?? '').toLowerCase()
    // || not ??: parseInt returns NaN, which is nullish to nobody, and NaN < anything is false — so
    // a junk appVer would silently mean "up to date" rather than falling back to -1.
    const appVer = Number.parseInt(header(req.headers['x-app-ver']) ?? '', 10) || -1

    const arch = (header(req.headers['x-arch']) ?? '').toLowerCase()
    const release = RELEASES[platformOf(os, arch)] ?? null

    return {
      variableA: 123,
      featureX: os === 'windows',
      appUpdate: release && appVer < release.versionCode ? release : null,
      engineJs: ENGINE_JS,
      playerJs: PLAYER_JS,
    }
  })
}
