import { createHash } from 'node:crypto'

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
  /** The full release notes; the update dialog's "Full changelog". */
  changelogUrl?: string | null
  /** The web page the dialog's "Download" opens when [installInApp] is false. */
  downloadPage?: string | null
  /**
   * Whether this build can upgrade the installed one in place ("Install now"). False when it cannot
   * be installed over it (e.g. signed with another key): the app offers [downloadPage] instead.
   * Absent = true.
   */
  installInApp?: boolean
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

/** One whole config: what a caller is answered from. */
export interface BaseConfig {
  /** Sent to every caller under `features`. */
  flags: Record<string, unknown>
  /** Per x-os (lower-case) overrides of [flags]. */
  flagsByOs: Record<string, Record<string, unknown>>
  /**
   * The newest build per platform, null while none is published. Desktop keys carry the arch
   * (`macos-arm64`), Android the device's primary ABI (`android-arm64-v8a`): one APK per ABI.
   */
  releases: Record<string, AppRelease | null>
  /**
   * The newest JS bundles, or null while none is published. Not per-platform: both run in QuickJS
   * everywhere. engine.js goes live at once, player.js at the next player session.
   */
  engineJs: SignedBundle | null
  playerJs: SignedBundle | null
}

/**
 * An A/B test of two whole configs: the stored one is A, [b] is B. A device's bucket is
 * hash(device ID) % 100 — the same device always lands in the same bucket — and buckets below A's
 * share get A. Exactly one of [percentB] (a fixed split) and [rollout] (B's share rising in a
 * straight line from `startB` at `startAt` to 100 at `endAt`) is set. As a rollout's B share
 * grows, devices only ever move from A to B.
 */
export interface AbTest {
  b: BaseConfig
  percentB?: number
  rollout?: { startB: number; startAt: string; endAt: string }
  /** Whether the [AppConfig.testDevices] always get B, whatever their bucket. */
  testDevices: boolean
}

/** A device kept for testing, across A/B tests. */
export interface TestDevice {
  id: string
  label?: string
}

/** One version of everything /v1/config answers from, as stored in app_config. */
export interface AppConfig extends BaseConfig {
  /** The running A/B test, if any. Absent = everyone gets this config. */
  ab?: AbTest
  /** Our own devices, kept from one A/B test to the next. Absent = none. */
  testDevices?: TestDevice[]
}

/** The first stored version, seeded into an empty app_config. */
export const DEFAULT_APP_CONFIG: AppConfig = {
  flags: { variableA: 123, featureX: false, telegramUrl: 'https://t.me/ymusic_io' },
  flagsByOs: { windows: { featureX: true } },
  releases: {
    'android-armeabi-v7a': null,
    'android-arm64-v8a': null,
    'android-x86': null,
    'android-x86_64': null,
    'macos-arm64': null,
    'macos-x64': null,
    'windows-x64': null,
    'linux-x64': null,
  },
  engineJs: null,
  playerJs: null,
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** What is wrong with [value] as an AppConfig, one message per problem; empty = valid. */
export function validateAppConfig(value: unknown): string[] {
  if (!isObject(value)) return ['the config must be a JSON object']
  const { ab, testDevices, ...base } = value
  const errors = validateBaseConfig(base)
  if (ab !== undefined) errors.push(...validateAbTest(ab))
  if (testDevices !== undefined) {
    const valid = (device: unknown) =>
      isObject(device) && typeof device.id === 'string' && device.id !== '' &&
      (device.label === undefined || typeof device.label === 'string')
    if (!Array.isArray(testDevices) || !testDevices.every(valid)) {
      errors.push('testDevices must be a list of { id, label? }')
    }
  }
  return errors
}

function validateAbTest(ab: unknown): string[] {
  if (!isObject(ab)) return ['ab must be an object']
  const errors: string[] = []
  const known = new Set(['b', 'percentB', 'rollout', 'testDevices'])
  for (const key of Object.keys(ab)) if (!known.has(key)) errors.push(`unknown key "ab.${key}"`)

  if (!isObject(ab.b)) errors.push('ab.b must be a whole config')
  else errors.push(...validateBaseConfig(ab.b).map((error) => `ab.b: ${error}`))

  const isPercent = (n: unknown) => typeof n === 'number' && n >= 0 && n <= 100
  if ((ab.percentB === undefined) === (ab.rollout === undefined)) {
    errors.push('ab needs exactly one of percentB and rollout')
  }
  if (ab.percentB !== undefined && !isPercent(ab.percentB)) errors.push('ab.percentB must be a number from 0 to 100')
  if (ab.rollout !== undefined) {
    const rollout = ab.rollout
    if (!isObject(rollout)) errors.push('ab.rollout must be an object')
    else {
      if (!isPercent(rollout.startB)) errors.push('ab.rollout.startB must be a number from 0 to 100')
      const time = (key: 'startAt' | 'endAt') => {
        const ms = typeof rollout[key] === 'string' ? Date.parse(rollout[key]) : Number.NaN
        if (Number.isNaN(ms)) errors.push(`ab.rollout.${key} must be a date`)
        return ms
      }
      const start = time('startAt'), end = time('endAt')
      if (end <= start) errors.push('ab.rollout.endAt must be after startAt')
    }
  }
  if (typeof ab.testDevices !== 'boolean') errors.push('ab.testDevices must be true or false')
  return errors
}

function validateBaseConfig(value: Record<string, unknown>): string[] {
  const errors: string[] = []
  const known = new Set(['flags', 'flagsByOs', 'releases', 'engineJs', 'playerJs'])
  for (const key of Object.keys(value)) if (!known.has(key)) errors.push(`unknown key "${key}"`)

  if (!isObject(value.flags)) errors.push('flags must be an object')
  if (!isObject(value.flagsByOs)) errors.push('flagsByOs must be an object')
  else {
    for (const [os, flags] of Object.entries(value.flagsByOs)) {
      if (!isObject(flags)) errors.push(`flagsByOs.${os} must be an object`)
    }
  }

  const fields = (object: Record<string, unknown>, where: string, spec: Record<string, 'number' | 'string'>) => {
    for (const [key, type] of Object.entries(spec)) {
      if (typeof object[key] !== type) errors.push(`${where}.${key} must be a ${type}`)
    }
  }
  if (!isObject(value.releases)) errors.push('releases must be an object')
  else {
    for (const [platform, release] of Object.entries(value.releases)) {
      if (release === null) continue
      if (!isObject(release)) {
        errors.push(`releases.${platform} must be null or a release`)
        continue
      }
      const where = `releases.${platform}`
      fields(release, where, {
        versionCode: 'number',
        versionName: 'string',
        notes: 'string',
        url: 'string',
        size: 'number',
        sha256: 'string',
        signature: 'string',
      })
      for (const key of ['changelogUrl', 'downloadPage'] as const) {
        const url = release[key]
        if (url !== undefined && url !== null && typeof url !== 'string') errors.push(`${where}.${key} must be a string or null`)
      }
      if (release.installInApp !== undefined && typeof release.installInApp !== 'boolean') {
        errors.push(`${where}.installInApp must be true or false`)
      }
      if (release.installInApp === false && typeof release.downloadPage !== 'string') {
        errors.push(`${where}.downloadPage is required when installInApp is false`)
      }
    }
  }
  for (const name of ['engineJs', 'playerJs'] as const) {
    const bundle = value[name]
    if (bundle === null) continue
    if (!isObject(bundle)) errors.push(`${name} must be null or a bundle`)
    else fields(bundle, name, { version: 'number', url: 'string', signature: 'string' })
  }
  return errors
}

/** The release for this caller: `<os>-<arch>`, or `<os>` for a caller that sends no arch. */
function releaseFor(releases: BaseConfig['releases'], os: string, arch: string): AppRelease | null {
  return (arch === '' ? releases[os] : releases[`${os}-${arch}`]) ?? null
}

/** B's share of devices, 0–100, at [now]. */
export function percentB(ab: AbTest, now: number): number {
  if (ab.percentB !== undefined) return ab.percentB
  const { startB, startAt, endAt } = ab.rollout!
  const start = Date.parse(startAt), end = Date.parse(endAt)
  const progress = Math.min(1, Math.max(0, (now - start) / (end - start)))
  return startB + (100 - startB) * progress
}

/** The device's bucket, 0–99: stable for a device ID, whatever the config. */
export function bucketOf(deviceId: string): number {
  return createHash('sha256').update(deviceId.toLowerCase()).digest().readUInt32BE(0) % 100
}

/** Which config of the A/B test the device gets. No device ID gets A. */
export function variantFor(ab: AbTest, testDevices: TestDevice[], deviceId: string, now: number): 'A' | 'B' {
  if (deviceId === '') return 'A'
  const id = deviceId.toLowerCase()
  if (ab.testDevices && testDevices.some((test) => test.id.trim().toLowerCase() === id)) return 'B'
  return bucketOf(id) < 100 - percentB(ab, now) ? 'A' : 'B'
}

/** The /v1/config answer for one caller. */
export function resolveAppConfig(
  stored: AppConfig,
  caller: { os: string; arch: string; appVer: number; deviceId: string },
  now = Date.now(),
) {
  const { ab, testDevices = [], ...a } = stored
  const config = ab && variantFor(ab, testDevices, caller.deviceId, now) === 'B' ? ab.b : a
  const release = releaseFor(config.releases, caller.os, caller.arch)
  return {
    features: { ...config.flags, ...config.flagsByOs[caller.os] },
    appUpdate: release && caller.appVer < release.versionCode ? release : null,
    engineJs: config.engineJs,
    playerJs: config.playerJs,
  }
}
