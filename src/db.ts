import { readFileSync } from 'node:fs'
import pg from 'pg'

/**
 * The event allowlist and per-event handlers — the ONLY door to a table. An entry says which
 * table an event lands in, which columns it has beyond (device_id, at), and how to turn the
 * wire props into those columns' values; `null` rejects the event. Adding an event is one entry
 * here plus its CREATE TABLE in [MIGRATION] (and the client recording it); an unknown name from
 * the wire is dropped at the route, never stored, never DDL'd.
 */
export interface EventDef {
  table: string
  /** Columns beyond (device_id, at), filled by [values] in the same order. */
  columns: readonly string[]
  /** Parse the wire props into column values; null = malformed, drop the event. */
  values(props: Record<string, string>): unknown[] | null
}

export const EVENTS: Record<string, EventDef> = {
  app_start: {
    table: 'event_app_start',
    columns: [],
    values: () => [],
  },
  app_update: {
    table: 'event_app_update',
    columns: ['from_version', 'to_version'],
    values: (props) => {
      const from = Number.parseInt(props.fromVersion ?? '', 10)
      const to = Number.parseInt(props.toVersion ?? '', 10)
      return Number.isInteger(from) && Number.isInteger(to) ? [from, to] : null
    },
  },
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
CREATE TABLE IF NOT EXISTS event_app_update (
  device_id    uuid NOT NULL,
  at           timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  from_version integer NOT NULL,
  to_version   integer NOT NULL
);
CREATE INDEX IF NOT EXISTS event_app_update_at ON event_app_update (at);
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
  /** What the event's [EventDef.values] handler extracted, in [EventDef.columns] order. */
  values: unknown[]
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
   * The whole batch as ONE statement — data-modifying CTEs chain the device upsert, the day
   * credits and every event insert into a single round trip, which is what matters when the
   * leaf server is far from this database. A single statement is also implicitly atomic, so
   * there is no BEGIN/COMMIT and no client checkout to manage. Throws on failure — the route
   * answers 500 and the client's disk queue retries.
   */
  async ingest(input: {
    deviceId: string
    os: string
    appVersion: number
    country: string | null
    events: AcceptedEvent[]
    /** UTC days to credit; empty when the activity cookie already covered the batch. */
    days: string[]
  }): Promise<void> {
    const params: unknown[] = []
    const bind = (value: unknown): string => {
      params.push(value)
      return `$${params.length}`
    }

    const ctes: string[] = []
    if (input.days.length > 0) {
      ctes.push(
        `dev AS (
           INSERT INTO devices (id, os, app_version, country, created_at, updated_at)
           VALUES (${bind(input.deviceId)}, ${bind(input.os)}, ${bind(input.appVersion)}, ${bind(input.country)}, now(), now())
           ON CONFLICT (id) DO UPDATE SET
             os = EXCLUDED.os,
             app_version = EXCLUDED.app_version,
             country = COALESCE(EXCLUDED.country, devices.country),
             updated_at = now())`,
      )
      ctes.push(
        `act AS (
           INSERT INTO daily_activity (day, device_id)
           SELECT unnest(${bind(input.days)}::date[]), ${bind(input.deviceId)}
           ON CONFLICT DO NOTHING)`,
      )
    }

    const byTable = new Map<string, { def: EventDef; rows: AcceptedEvent[] }>()
    for (const event of input.events) {
      const def = EVENTS[event.name]
      if (!def) continue // the route filtered already; never trust that from here
      const group = byTable.get(def.table)
      if (group) group.rows.push(event)
      else byTable.set(def.table, { def, rows: [event] })
    }
    let n = 0
    for (const [table, { def, rows }] of byTable) {
      // Table and column names come from OUR registry above, never from the wire.
      const columns = ['device_id', 'at', ...def.columns].join(', ')
      const tuples = rows
        .map((row) => `(${[bind(input.deviceId), bind(row.at), ...row.values.map(bind)].join(', ')})`)
        .join(', ')
      ctes.push(`e${n++} AS (INSERT INTO ${table} (${columns}) VALUES ${tuples})`)
    }

    if (ctes.length === 0) return
    await this.pool.query(`WITH ${ctes.join(',\n')} SELECT 1`, params)
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
