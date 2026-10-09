import type { FastifyInstance } from 'fastify'
import { header } from '../headers.js'

/** An available build. [checksum] is sha256 of the bytes at [url]. */
export interface NewVersion {
  url: string
  changelog: string
  size: string
  checksum: string
}

/** The newest build per platform, and the version below which it is offered. */
const RELEASES: Record<string, { belowVersionCode: number; newVersion: NewVersion }> = {
  windows: {
    belowVersionCode: 1234,
    newVersion: {
      url: 'https://cfg.ymusic.io/static/ymusic-1234-windows-x64.exe',
      changelog: 'https://cfg.ymusic.io/static/changelog-1234.md',
      size: '0',
      checksum: '',
    },
  },
  android: {
    belowVersionCode: 1234,
    newVersion: {
      url: 'https://cfg.ymusic.io/static/ymusic-1234.apk',
      changelog: 'https://cfg.ymusic.io/static/changelog-1234.md',
      size: '0',
      checksum: '',
    },
  },
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
    // The common context — os, appVer, device uuid — rides as headers on every API call; this
    // route only reads the first two. Fastify lowercases header names.
    const os = (header(req.headers['x-os']) ?? '').toLowerCase()
    // || not ??: parseInt returns NaN, which is nullish to nobody, and NaN < anything is false — so
    // a junk appVer would silently mean "up to date" rather than falling back to -1.
    const appVer = Number.parseInt(header(req.headers['x-app-ver']) ?? '', 10) || -1

    const release = RELEASES[os]

    return {
      variableA: 123,
      featureX: os === 'windows',
      newVersion: release && appVer < release.belowVersionCode ? release.newVersion : null,
      engineJs: ENGINE_JS,
      playerJs: PLAYER_JS,
    }
  })
}
