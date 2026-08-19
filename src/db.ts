import { readFileSync } from 'node:fs'
import pg from 'pg'

/**
 * The event allowlist — the ONLY door to a table. Adding an event is one entry here plus its
 * CREATE TABLE in [MIGRATION] (and the client recording it); an unknown name from the wire is
 * dropped at the route, never stored, never DDL'd.
 */
export const EVENTS: Record<string, { table: string }> = {
  app_start: { table: 'event_app_start' },
}

/**
 * Idempotent, runs at boot. Unqualified names land in schema `app` (the pool forces
 * search_path=app), which initdb created with ymusic_server as owner — so this role may CREATE
 * here and nowhere else, and the read-only dashboard role sees every new table automatically.
 */
const MIGRATION = `
CREATE TABLE IF NOT EXISTS devices (
  id          uuid PRIMARY KEY,
  os          text NOT NULL,
  app_version integer NOT NULL,
  country     text,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_activity (
  day       date NOT NULL,
  device_id uuid NOT NULL,
  PRIMARY KEY (day, device_id)
);
CREATE TABLE IF NOT EXISTS event_app_start (
  device_id   uuid NOT NULL,
  at          timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_app_start_at ON event_app_start (at);
`

/** [dsn] should be the ymusic_server role; the cert files come from the private DB CA. */
export interface PgSettings {
  dsn: string
  caFile?: string | undefined
  certFile?: string | undefined
  keyFile?: string | undefined
}

export interface AcceptedEvent {
  name: string
  at: Date
}

export class Analytics {
  private constructor(private readonly pool: pg.Pool) {}

  static async open(settings: PgSettings): Promise<Analytics> {
    const pool = new pg.Pool({
      connectionString: settings.dsn,
      ssl: settings.caFile
        ? {
            ca: readFileSync(settings.caFile, 'utf8'),
            cert: settings.certFile ? readFileSync(settings.certFile, 'utf8') : undefined,
            key: settings.keyFile ? readFileSync(settings.keyFile, 'utf8') : undefined,
          }
        : undefined,
      options: '-c search_path=app',
      max: 5,
    })
    await pool.query(MIGRATION)
    return new Analytics(pool)
  }

  /**
   * One batch, one transaction: the device upsert and day credits ([days] is empty when the
   * activity cookie already covered the batch), then the allowlisted events into their tables.
   * Throws on any failure — the route answers 500 and the client's disk queue retries.
   */
  async ingest(input: {
    deviceId: string
    os: string
    appVersion: number
    country: string | null
    events: AcceptedEvent[]
    days: string[]
  }): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      if (input.days.length > 0) {
        await client.query(
          `INSERT INTO devices (id, os, app_version, country, created_at, updated_at)
           VALUES ($1, $2, $3, $4, now(), now())
           ON CONFLICT (id) DO UPDATE SET
             os = EXCLUDED.os,
             app_version = EXCLUDED.app_version,
             country = COALESCE(EXCLUDED.country, devices.country),
             updated_at = now()`,
          [input.deviceId, input.os, input.appVersion, input.country],
        )
        await client.query(
          `INSERT INTO daily_activity (day, device_id)
           SELECT unnest($1::date[]), $2 ON CONFLICT DO NOTHING`,
          [input.days, input.deviceId],
        )
      }
      const byTable = new Map<string, Date[]>()
      for (const event of input.events) {
        const table = EVENTS[event.name]?.table
        if (!table) continue // the route filtered already; never trust that from here
        const ats = byTable.get(table)
        if (ats) ats.push(event.at)
        else byTable.set(table, [event.at])
      }
      for (const [table, ats] of byTable) {
        // Table names come from OUR registry above, never from the wire — safe to splice.
        await client.query(
          `INSERT INTO ${table} (device_id, at) SELECT $1, unnest($2::timestamptz[])`,
          [input.deviceId, ats],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
