import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AbTest,
  type AppConfig,
  type AppRelease,
  bucketOf,
  DEFAULT_APP_CONFIG,
  percentB,
  validateAppConfig,
  variantFor,
} from '../src/appConfig.js'
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
  config.releases['android-arm64-v8a'] = release(1234, 'https://x/ymusic-1234-arm64-v8a.apk')
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
    const android = await get('android', '1', 'arm64-v8a')
    const windows = await get('windows', '1', 'x64')

    expect(android.json().appUpdate.url).toContain('.apk')
    expect(windows.json().appUpdate.url).toContain('.msi')
  })

  it('picks the desktop build by arch, and offers none without one', async () => {
    expect((await get('macos', '1', 'arm64')).json().appUpdate.url).toContain('arm64')
    expect((await get('macos', '1', 'x64')).json().appUpdate).toBeNull()
    expect((await get('macos', '1')).json().appUpdate).toBeNull()
  })

  it('offers android the APK for its ABI, and none for an ABI without one', async () => {
    expect((await get('android', '1', 'arm64-v8a')).json().appUpdate.url).toContain('arm64-v8a')
    expect((await get('android', '1', 'x86')).json().appUpdate).toBeNull()
    expect((await get('android', '1')).json().appUpdate).toBeNull()
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

describe('A/B test', () => {
  /** Device IDs and their buckets: enough of them to land on both sides of any split. */
  const devices = Array.from({ length: 200 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
  const inBucket = (test: (bucket: number) => boolean) => devices.find((id) => test(bucketOf(id)))!

  function startTest(ab: Partial<AbTest>) {
    const { ab: _, testDevices: __, ...a } = config
    config.ab = { b: { ...structuredClone(a), flags: { side: 'B' } }, testDevices: false, ...ab }
    config.flags = { side: 'A' }
  }
  const side = async (deviceId?: string) => {
    const headers: Record<string, string> = { 'x-os': 'windows' }
    if (deviceId !== undefined) headers['x-device-id'] = deviceId
    return (await app.inject({ url: '/v1/config', headers })).json().features.side
  }

  it('puts buckets below A\'s share on A and the rest on B', async () => {
    startTest({ percentB: 70 })

    expect(await side(inBucket((b) => b < 30))).toBe('A')
    expect(await side(inBucket((b) => b >= 30))).toBe('B')
  })

  it('keeps a device in the same bucket, whatever its case', () => {
    const id = devices[7]!
    expect(bucketOf(id.toUpperCase())).toBe(bucketOf(id))
    expect(bucketOf(id)).toBeGreaterThanOrEqual(0)
    expect(bucketOf(id)).toBeLessThan(100)
  })

  it('splits devices roughly by the percentages', () => {
    const ab: AbTest = { b: DEFAULT_APP_CONFIG, percentB: 70, testDevices: false }
    const onB = devices.filter((id) => variantFor(ab, [], id, 0) === 'B').length
    expect(onB / devices.length).toBeGreaterThan(0.55)
    expect(onB / devices.length).toBeLessThan(0.85)
  })

  it('answers the whole of config B, releases included', async () => {
    startTest({ percentB: 100 })
    config.ab!.b.releases['windows-x64'] = release(2000, 'https://x/ymusic-2000.msi')

    const res = (await get('windows', '1234', 'x64', devices[0])).json()
    expect(res.features).toEqual({ side: 'B', featureX: true })
    expect(res.appUpdate.versionCode).toBe(2000)
  })

  it('sends test devices to B whatever their bucket, and A to a caller without a device ID', async () => {
    const id = devices[3]!
    config.testDevices = [{ id: ` ${id.toUpperCase()} `, label: 'QA phone' }]
    startTest({ percentB: 0, testDevices: true })

    expect(await side(id)).toBe('B')
    expect(await side(devices[4])).toBe('A')
    expect(await side()).toBe('A')
  })

  it('keeps test devices in their bucket while the test leaves them out', async () => {
    const id = inBucket((b) => b < 50)
    config.testDevices = [{ id }]
    startTest({ percentB: 50, testDevices: false })

    expect(await side(id)).toBe('A')
  })

  it('rolls B out in a straight line from startB to 100%, then stays there', () => {
    const ab: AbTest = {
      b: DEFAULT_APP_CONFIG,
      rollout: { startB: 10, startAt: '2026-10-01T00:00:00Z', endAt: '2026-10-11T00:00:00Z' },
      testDevices: false,
    }
    expect(percentB(ab, Date.parse('2026-09-01T00:00:00Z'))).toBe(10)
    expect(percentB(ab, Date.parse('2026-10-06T00:00:00Z'))).toBe(55)
    expect(percentB(ab, Date.parse('2026-12-01T00:00:00Z'))).toBe(100)
  })

  it('only ever moves a device from A to B as the rollout goes on', () => {
    const ab: AbTest = {
      b: DEFAULT_APP_CONFIG,
      rollout: { startB: 0, startAt: '2026-10-01T00:00:00Z', endAt: '2026-10-11T00:00:00Z' },
      testDevices: false,
    }
    for (const id of devices.slice(0, 50)) {
      let wasB = false
      for (let day = 0; day <= 10; day++) {
        const isB = variantFor(ab, [], id, Date.parse('2026-10-01T00:00:00Z') + day * 86_400_000) === 'B'
        expect(wasB && !isB, id).toBe(false)
        wasB = isB
      }
      expect(wasB).toBe(true)
    }
  })

  it('validates the test', () => {
    const ok = (ab: unknown) => validateAppConfig({ ...DEFAULT_APP_CONFIG, ab })
    const b = DEFAULT_APP_CONFIG

    expect(ok({ b, percentB: 30, testDevices: false })).toEqual([])
    expect(ok({ b, rollout: { startB: 5, startAt: '2026-10-01T00:00:00Z', endAt: '2026-10-08' }, testDevices: true })).toEqual([])
    expect(ok({ b, testDevices: false })).toContain('ab needs exactly one of percentB and rollout')
    expect(ok({ b, percentB: 101, testDevices: false })).toContain('ab.percentB must be a number from 0 to 100')
    expect(ok({ b, rollout: { startB: 5, startAt: '2026-10-08', endAt: '2026-10-01' }, testDevices: false }))
      .toContain('ab.rollout.endAt must be after startAt')
    expect(ok({ b: { ...b, ab: {} }, percentB: 1, testDevices: false })).toContain('ab.b: unknown key "ab"')
    expect(ok({ b: { ...b, testDevices: [] }, percentB: 1, testDevices: false })).toContain('ab.b: unknown key "testDevices"')
    expect(ok({ b: { flags: {} }, percentB: 1, testDevices: false })).toContain('ab.b: flagsByOs must be an object')
    expect(ok({ b, percentB: 1, testDevices: ['x'] })).toContain('ab.testDevices must be true or false')

    const devices = (testDevices: unknown) => validateAppConfig({ ...DEFAULT_APP_CONFIG, testDevices })
    expect(devices([{ id: 'x', label: 'QA phone' }, { id: 'y' }])).toEqual([])
    expect(devices(['x'])).toContain('testDevices must be a list of { id, label? }')
    expect(devices([{ id: '' }])).toContain('testDevices must be a list of { id, label? }')
  })
})
