import type { FastifyInstance } from 'fastify'

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
 * The newest JS bundles. Not per-platform: both run everywhere, the webview script in the WebView and
 * the engine in QuickJS. The client compares the version against the one it already has, so bumping
 * these is what ships a scraping fix without a release.
 */
const WV_JS = { version: 123, url: 'https://cfg.ymusic.io/static/webview_ymusic-123.js' }
const ENGINE_JS = { version: 11, url: 'https://cfg.ymusic.io/static/engine_ymusic-11.js' }

/**
 * What the app asks for at startup: feature flags, the newest JS bundles, and whether a newer build
 * exists.
 *
 * No cache headers on purpose — caching is the reverse proxy's job, and a Cache-Control set here
 * would override whatever it decides.
 */
/** Node hands a repeated header over as an array; a client sending one twice gets the first. */
function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

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
      wvJs: WV_JS,
      engineJs: ENGINE_JS,
    }
  })
}
