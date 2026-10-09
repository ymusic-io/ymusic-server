import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.js'

let app: Awaited<ReturnType<typeof buildServer>>

/** Shared by the whole-body assertions, which would otherwise restate the bundles twice. */
const BUNDLES = {
  engineJs: null,
  playerJs: null,
}

/** The common context — os, appVer, device uuid — rides as headers on every API call. */
function get(os?: string, appVer?: string, deviceId = 'abc') {
  const headers: Record<string, string> = { 'x-device-id': deviceId }
  if (os !== undefined) headers['x-os'] = os
  if (appVer !== undefined) headers['x-app-ver'] = appVer
  return app.inject({ url: '/v1/config', headers })
}

beforeEach(async () => {
  app = await buildServer()
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

describe('GET /v1/config', () => {
  it('answers the flags and no update for a current build', async () => {
    const res = await get('windows', '1234')

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ variableA: 123, featureX: true, newVersion: null, ...BUNDLES })
  })

  it('offers the update to an older build', async () => {
    const res = await get('windows', '1233')

    expect(res.json().newVersion).toEqual({
      url: expect.stringContaining('windows'),
      changelog: expect.any(String),
      size: expect.any(String),
      checksum: expect.any(String),
    })
  })

  it('keys the update off the platform, so android and windows are independent', async () => {
    const android = await get('android', '1')
    const windows = await get('windows', '1')

    expect(android.json().newVersion.url).toContain('.apk')
    expect(windows.json().newVersion.url).toContain('windows')
  })

  it('offers nothing to a platform with no release', async () => {
    const res = await get('solaris', '1')

    expect(res.statusCode).toBe(200)
    expect(res.json().newVersion).toBeNull()
  })

  it('is case-insensitive about os', async () => {
    expect((await get('Windows', '1234')).json().featureX).toBe(true)
  })

  it('treats a missing or junk appVer as -1, so such a caller is offered the update', async () => {
    for (const appVer of [undefined, 'nonsense']) {
      expect((await get('windows', appVer)).json().newVersion, String(appVer)).not.toBeNull()
    }
  })

  it('ignores os/appVer in the query: headers are the contract now', async () => {
    const res = await app.inject('/v1/config?os=windows&appVer=1&deviceId=abc')

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ variableA: 123, featureX: false, newVersion: null, ...BUNDLES })
  })

  it('answers a request with no headers and no query at all', async () => {
    const res = await app.inject('/v1/config')

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ variableA: 123, featureX: false, newVersion: null, ...BUNDLES })
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
