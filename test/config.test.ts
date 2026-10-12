import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AppConfig, type AppRelease, DEFAULT_APP_CONFIG } from '../src/appConfig.js'
import { StaticConfig } from '../src/configStore.js'
import { buildServer } from '../src/server.js'

let app: Awaited<ReturnType<typeof buildServer>>

/** Shared by the whole-body assertions, which would otherwise restate the bundles twice. */
const BUNDLES = {
  engineJs: null,
  playerJs: null,
}

function release(versionCode: number, url: string): AppRelease {
  return { versionCode, versionName: '4.1.0', notes: 'n', url, size: 12, sha256: 'ab', signature: 'sig' }
}

/** The common context — os, arch, appVer, device uuid — rides as headers on every API call. */
function get(os?: string, appVer?: string, arch?: string, deviceId = 'abc') {
  const headers: Record<string, string> = { 'x-device-id': deviceId }
  if (os !== undefined) headers['x-os'] = os
  if (arch !== undefined) headers['x-arch'] = arch
  if (appVer !== undefined) headers['x-app-ver'] = appVer
  return app.inject({ url: '/v1/config', headers })
}

/** The served config; a test may publish more releases into it before asking. */
let config: AppConfig

beforeEach(async () => {
  config = structuredClone(DEFAULT_APP_CONFIG)
  config.releases['windows-x64'] = release(1234, 'https://x/ymusic-1234.msi')
  config.releases['macos-arm64'] = release(1234, 'https://x/ymusic-1234-arm64.dmg')
  config.releases.android = release(1234, 'https://x/ymusic-1234.apk')
  app = await buildServer({ config: new StaticConfig(config) })
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

describe('GET /v1/config', () => {
  it('answers the flags and no update for a current build', async () => {
    const res = await get('windows', '1234', 'x64')

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ features: { variableA: 123, featureX: true, telegramUrl: 'https://t.me/ymusic_io' }, appUpdate: null, ...BUNDLES })
  })

  it('offers the update to an older build', async () => {
    const res = await get('windows', '1233', 'x64')

    expect(res.json().appUpdate).toEqual(release(1234, 'https://x/ymusic-1234.msi'))
  })

  it('keys the update off the platform, so android and windows are independent', async () => {
    const android = await get('android', '1')
    const windows = await get('windows', '1', 'x64')

    expect(android.json().appUpdate.url).toContain('.apk')
    expect(windows.json().appUpdate.url).toContain('.msi')
  })

  it('picks the desktop build by arch, and offers none without one', async () => {
    expect((await get('macos', '1', 'arm64')).json().appUpdate.url).toContain('arm64')
    expect((await get('macos', '1', 'x64')).json().appUpdate).toBeNull()
    expect((await get('macos', '1')).json().appUpdate).toBeNull()
  })

  it('offers android its split APK when published, else the universal one', async () => {
    config.releases['android-arm64-v8a'] = release(1234, 'https://x/ymusic-1234-arm64-v8a.apk')
    expect((await get('android', '1', 'arm64-v8a')).json().appUpdate.url).toContain('arm64-v8a')
    expect((await get('android', '1', 'x86_64')).json().appUpdate.url).toBe('https://x/ymusic-1234.apk')
    expect((await get('android', '1')).json().appUpdate.url).toBe('https://x/ymusic-1234.apk')
  })

  it('offers nothing to a platform with no release', async () => {
    const res = await get('solaris', '1')

    expect(res.statusCode).toBe(200)
    expect(res.json().appUpdate).toBeNull()
  })

  it('is case-insensitive about os', async () => {
    expect((await get('Windows', '1234')).json().features.featureX).toBe(true)
  })

  it('treats a missing or junk appVer as -1, so such a caller is offered the update', async () => {
    for (const appVer of [undefined, 'nonsense']) {
      expect((await get('windows', appVer, 'x64')).json().appUpdate, String(appVer)).not.toBeNull()
    }
  })

  it('ignores os/appVer in the query: headers are the contract now', async () => {
    const res = await app.inject('/v1/config?os=windows&appVer=1&deviceId=abc')

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ features: { variableA: 123, featureX: false, telegramUrl: 'https://t.me/ymusic_io' }, appUpdate: null, ...BUNDLES })
  })

  it('answers a request with no headers and no query at all', async () => {
    const res = await app.inject('/v1/config')

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ features: { variableA: 123, featureX: false, telegramUrl: 'https://t.me/ymusic_io' }, appUpdate: null, ...BUNDLES })
  })

  it('sets no cache-control, leaving caching to the reverse proxy', async () => {
    const res = await get('windows', '1')

    expect(res.headers['cache-control']).toBeUndefined()
    expect(res.headers['etag']).toBeUndefined()
  })

  it('publishes the same JS bundles regardless of platform', async () => {
    const windows = (await get('windows', '1234')).json()
    const android = (await get('android', '1234')).json()

    // Both bundles run everywhere; a per-platform answer here would be a bug, not a feature.
    expect(android.engineJs).toEqual(windows.engineJs)
    expect(android.playerJs).toEqual(windows.playerJs)
    expect(windows).not.toHaveProperty('wvJs')
  })

  it('serves nothing else', async () => {
    expect((await app.inject('/static/anything')).statusCode).toBe(404)
    expect((await app.inject('/v1/update')).statusCode).toBe(404)
  })
})
