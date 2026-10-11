import type { FastifyBaseLogger } from 'fastify'
import type pg from 'pg'
import type { AppConfig } from './appConfig.js'

/** One row of app_config. The table is append-only: the newest row is the live config. */
export interface ConfigVersion {
  id: number
  config: AppConfig
  note: string | null
  author: string | null
  created_at: string
  /** Set when this version restored an older one. */
  reverted_from: number | null
}

const COLUMNS = `id::int AS id, config, note, author, created_at::text AS created_at, reverted_from::int AS reverted_from`

export async function latestConfig(pool: pg.Pool): Promise<ConfigVersion> {
  const { rows } = await pool.query<ConfigVersion>(`SELECT ${COLUMNS} FROM app_config ORDER BY id DESC LIMIT 1`)
  if (!rows[0]) throw new Error('app_config is empty — the migration seeds it')
  return rows[0]
}

export async function configVersion(pool: pg.Pool, id: number): Promise<ConfigVersion | undefined> {
  return (await pool.query<ConfigVersion>(`SELECT ${COLUMNS} FROM app_config WHERE id = $1`, [id])).rows[0]
}

/** Newest first, without the config bodies. */
export async function configHistory(pool: pg.Pool, limit: number): Promise<Omit<ConfigVersion, 'config'>[]> {
  const { rows } = await pool.query(
    `SELECT id::int AS id, note, author, created_at::text AS created_at, reverted_from::int AS reverted_from
     FROM app_config ORDER BY id DESC LIMIT $1`,
    [limit],
  )
  return rows
}

/** Thrown when the live version is no longer the one the edit started from. */
export class StaleBase extends Error {}

/**
 * Runs [insert] as the next version, under a lock, only while [baseId] — the live version the
 * editor started from — is still the newest; anything newer is a conflicting edit, refused rather
 * than overwritten. [insert] returns the row, or nothing to abort without writing.
 */
async function appendVersion(
  pool: pg.Pool,
  baseId: number,
  insert: (client: pg.PoolClient) => Promise<ConfigVersion | undefined>,
): Promise<ConfigVersion | undefined> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('ymusic-app-config'))`)
    const { rows } = await client.query<{ id: number }>(`SELECT max(id)::int AS id FROM app_config`)
    if (rows[0]?.id !== baseId) {
      throw new StaleBase(`the live config is v${rows[0]?.id}, not v${baseId}: someone saved in between`)
    }
    const inserted = await insert(client)
    await client.query(inserted ? 'COMMIT' : 'ROLLBACK')
    client.release()
    return inserted
  } catch (error) {
    client.release(true) // closing the session rolls back
    throw error
  }
}

/** Appends an edited config as the next version. Validate it first (validateAppConfig). */
export async function appendConfig(
  pool: pg.Pool,
  entry: { config: AppConfig; note: string | null; author: string; baseId: number },
): Promise<ConfigVersion> {
  const inserted = await appendVersion(pool, entry.baseId, async (client) => {
    const { rows } = await client.query<ConfigVersion>(
      `INSERT INTO app_config (config, note, author) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
      [JSON.stringify(entry.config), entry.note, entry.author],
    )
    return rows[0]
  })
  return inserted!
}

/**
 * Appends a copy of version [targetId] as the next version — copied inside the database, so the
 * stored config is restored byte for byte. Undefined when there is no such version.
 */
export async function revertConfig(
  pool: pg.Pool,
  entry: { targetId: number; note: string | null; author: string; baseId: number },
): Promise<ConfigVersion | undefined> {
  return appendVersion(pool, entry.baseId, async (client) => {
    const { rows } = await client.query<ConfigVersion>(
      `INSERT INTO app_config (config, note, author, reverted_from)
       SELECT config, coalesce($2, 'revert to v' || id), $3, id FROM app_config WHERE id = $1
       RETURNING ${COLUMNS}`,
      [entry.targetId, entry.note, entry.author],
    )
    return rows[0]
  })
}

/** Where /v1/config reads the live config from. */
export interface ConfigSource {
  current(): Promise<AppConfig>
}

/** A fixed config: no database configured (plain dev, tests). */
export class StaticConfig implements ConfigSource {
  constructor(private readonly config: AppConfig) {}

  async current(): Promise<AppConfig> {
    return this.config
  }
}

/**
 * The live config, held in memory. Older than [maxAgeMs], it is still answered at once while one
 * background refresh fetches the newest; a failed refresh is logged and the cached copy kept. Only
 * the very first load is awaited — [refresh] it at boot so no request waits.
 */
export class CachedConfig implements ConfigSource {
  private value: AppConfig | undefined
  private checkedAt = 0
  private refreshing: Promise<void> | null = null

  constructor(
    private readonly pool: pg.Pool,
    private readonly log: FastifyBaseLogger,
    private readonly maxAgeMs = 60_000,
  ) {}

  async current(): Promise<AppConfig> {
    if (this.value === undefined) await this.refresh()
    else if (Date.now() - this.checkedAt >= this.maxAgeMs) {
      this.refresh().catch((error: unknown) =>
        this.log.warn({ err: error }, 'config refresh failed — serving the cached one'),
      )
    }
    return this.value!
  }

  refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      this.checkedAt = Date.now()
      try {
        this.value = (await latestConfig(this.pool)).config
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }
}
