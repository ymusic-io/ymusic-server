import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.js'

let app: Awaited<ReturnType<typeof buildServer>>

/** Shared by the whole-body assertions, which would otherwise restate the bundles twice. */
const BUNDLES = {
  wvJs: { version: expect.any(Number), url: expect.any(String) },
  engineJs: { version: expect.any(Number), url: expect.any(String) },
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
    const res = await app.inject('/v1/config?os=windows&appVer=1234&deviceId=abc')

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ variableA: 123, featureX: true, newVersion: null, ...BUNDLES })
  })

  it('offers the update to an older build', async () => {
    const res = await app.inject('/v1/config?os=windows&appVer=1233&deviceId=abc')

    expect(res.json().newVersion).toEqual({
      url: expect.stringContaining('windows'),
      changelog: expect.any(String),
      size: expect.any(String),
      checksum: expect.any(String),
    })
  })

  it('keys the update off the platform, so android and windows are independent', async () => {
    const android = await app.inject('/v1/config?os=android&appVer=1&deviceId=x')
    const windows = await app.inject('/v1/config?os=windows&appVer=1&deviceId=x')

    expect(android.json().newVersion.url).toContain('.apk')
    expect(windows.json().newVersion.url).toContain('windows')
  })

  it('offers nothing to a platform with no release', async () => {
    const res = await app.inject('/v1/config?os=solaris&appVer=1')

    expect(res.statusCode).toBe(200)
    expect(res.json().newVersion).toBeNull()
  })

  it('is case-insensitive about os', async () => {
    expect((await app.inject('/v1/config?os=Windows&appVer=1234')).json().featureX).toBe(true)
  })

  it('treats a missing or junk appVer as -1, so such a caller is offered the update', async () => {
    for (const url of ['/v1/config?os=windows', '/v1/config?os=windows&appVer=nonsense']) {
      expect((await app.inject(url)).json().newVersion, url).not.toBeNull()
    }
  })

  it('answers a request with no query at all', async () => {
    const res = await app.inject('/v1/config')

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ variableA: 123, featureX: false, newVersion: null, ...BUNDLES })
  })

  it('sets no cache-control, leaving caching to the reverse proxy', async () => {
    const res = await app.inject('/v1/config?os=windows&appVer=1')

    expect(res.headers['cache-control']).toBeUndefined()
    expect(res.headers['etag']).toBeUndefined()
  })

  it('publishes the latest JS bundle versions, regardless of platform', async () => {
    const windows = (await app.inject('/v1/config?os=windows&appVer=1234')).json()
    const android = (await app.inject('/v1/config?os=android&appVer=1234')).json()

    // The client compares these against what it has, so a version has to be a number to compare.
    expect(typeof windows.wvJs.version).toBe('number')
    expect(typeof windows.engineJs.version).toBe('number')
    expect(windows.wvJs.url).toMatch(/^https:/)
    expect(windows.engineJs.url).toMatch(/^https:/)
    // Both bundles run everywhere; a per-platform answer here would be a bug, not a feature.
    expect(android.wvJs).toEqual(windows.wvJs)
    expect(android.engineJs).toEqual(windows.engineJs)
  })

  it('serves nothing else', async () => {
    expect((await app.inject('/static/anything')).statusCode).toBe(404)
    expect((await app.inject('/v1/update')).statusCode).toBe(404)
  })
})
