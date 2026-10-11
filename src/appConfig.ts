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
 * A published JS bundle. `signature` authenticates the file at `url` for `version`: ECDSA P-256 over
 * `<name>:<version>:<sha256 hex of the file>`, made OFFLINE with `scripts/sign-bundle.mjs` — the
 * signing key never reaches this server. The app refuses any bundle whose bytes do not match.
 */
export interface SignedBundle {
  version: number
  url: string
  signature: string
}

/** One version of everything /v1/config answers from, as stored in app_config. */
export interface AppConfig {
  /** Sent to every caller as top-level keys. */
  flags: Record<string, unknown>
  /** Per x-os (lower-case) overrides of [flags]. */
  flagsByOs: Record<string, Record<string, unknown>>
  /**
   * The newest build per platform, null while none is published. Desktop keys carry the arch
   * (`macos-arm64`); Android gets its split APK (`android-arm64-v8a`) when one is published, else
   * the universal `android` one.
   */
  releases: Record<string, AppRelease | null>
  /**
   * The newest JS bundles, or null while none is published. Not per-platform: both run in QuickJS
   * everywhere. engine.js goes live at once, player.js at the next player session.
   */
  engineJs: SignedBundle | null
  playerJs: SignedBundle | null
}

/** The first stored version, seeded into an empty app_config. */
export const DEFAULT_APP_CONFIG: AppConfig = {
  flags: { variableA: 123, featureX: false },
  flagsByOs: { windows: { featureX: true } },
  releases: {
    android: null,
    'android-arm64-v8a': null,
    'android-x86_64': null,
    'macos-arm64': null,
    'macos-x64': null,
    'windows-x64': null,
    'linux-x64': null,
  },
  engineJs: null,
  playerJs: null,
}

const RESERVED = new Set(['appUpdate', 'engineJs', 'playerJs'])

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** What is wrong with [value] as an AppConfig, one message per problem; empty = valid. */
export function validateAppConfig(value: unknown): string[] {
  if (!isObject(value)) return ['the config must be a JSON object']
  const errors: string[] = []
  const known = new Set(['flags', 'flagsByOs', 'releases', 'engineJs', 'playerJs'])
  for (const key of Object.keys(value)) if (!known.has(key)) errors.push(`unknown key "${key}"`)

  const checkFlags = (flags: unknown, where: string) => {
    if (!isObject(flags)) return errors.push(`${where} must be an object`)
    for (const key of Object.keys(flags)) {
      if (RESERVED.has(key)) errors.push(`${where}.${key}: "${key}" is set by the server`)
    }
  }
  checkFlags(value.flags, 'flags')
  if (!isObject(value.flagsByOs)) errors.push('flagsByOs must be an object')
  else for (const [os, flags] of Object.entries(value.flagsByOs)) checkFlags(flags, `flagsByOs.${os}`)

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
      fields(release, `releases.${platform}`, {
        versionCode: 'number',
        versionName: 'string',
        notes: 'string',
        url: 'string',
        size: 'number',
        sha256: 'string',
        signature: 'string',
      })
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

/** The release for this caller: `<os>-<arch>`; Android falls back to its universal `android` APK. */
function releaseFor(releases: AppConfig['releases'], os: string, arch: string): AppRelease | null {
  const exact = arch === '' ? releases[os] : releases[`${os}-${arch}`]
  if (exact) return exact
  return os === 'android' ? (releases.android ?? null) : null
}

/** The /v1/config answer for one caller. */
export function resolveAppConfig(config: AppConfig, caller: { os: string; arch: string; appVer: number }) {
  const release = releaseFor(config.releases, caller.os, caller.arch)
  return {
    ...config.flags,
    ...config.flagsByOs[caller.os],
    appUpdate: release && caller.appVer < release.versionCode ? release : null,
    engineJs: config.engineJs,
    playerJs: config.playerJs,
  }
}
