import { readFileSync } from 'node:fs'
import pg from 'pg'

/**
 * The event allowlist and per-event handlers — the ONLY door to a table. An entry says which
 * table an event lands in, which columns it has beyond (device_id, at), and how to turn the
 * wire props into those columns' values; `null` rejects the event. Adding an event is one entry
 * here plus its CREATE TABLE in [MIGRATION] (and the client recording it); an unknown name from
 * the wire is dropped at the route, never stored, never DDL'd.
 */
/** The request-level context every handler may draw on, parsed from the common headers. */
export interface EventContext {
  os: string
  osVersion: string
  appVersion: number
  country: string | null
}

export interface EventDef {
  table: string
  /** Columns beyond (device_id, at), filled by [values] in the same order. */
  columns: readonly string[]
  /** Turn the wire props + request context into column values; null = malformed, drop it. */
  values(props: Record<string, string>, ctx: EventContext): unknown[] | null
}

export const EVENTS: Record<string, EventDef> = {
  app_start: {
    table: 'event_app_start',
    columns: [],
    values: () => [],
  },
  app_update: {
    table: 'event_app_update',
    columns: ['os', 'from_version', 'to_version'],
    values: (props, ctx) => {
      const from = Number.parseInt(props.fromVersion ?? '', 10)
      const to = Number.parseInt(props.toVersion ?? '', 10)
      return Number.isInteger(from) && Number.isInteger(to) ? [ctx.os, from, to] : null
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
  os_version  text,
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
  os           text,
  from_version integer NOT NULL,
  to_version   integer NOT NULL
);
CREATE INDEX IF NOT EXISTS event_app_update_at ON event_app_update (at);
-- Columns added after a table already shipped: IF NOT EXISTS on both sides keeps this
-- migration a pure statement of the current shape.
CREATE TABLE IF NOT EXISTS device_links (
  id         text PRIMARY KEY,
  payload    text,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS device_links_expires_at ON device_links (expires_at);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS os_version text;
ALTER TABLE event_app_update ADD COLUMN IF NOT EXISTS os text;
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

/** The one pool every store shares, migrated before anything uses it. */
export async function openPool(settings: PgSettings): Promise<pg.Pool> {
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
  return pool
}

export class Analytics {
  constructor(private readonly pool: pg.Pool) {}

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
    osVersion: string
    appVersion: number
    country: string | null
    events: AcceptedEvent[]
    /**
     * Days to credit as 'YYYY-MM-DD', bucketed in the DB's own timezone (+07 — see dayOf in
     * pulse.ts, THE single place a day is derived); empty when the activity cookie already
     * covered the batch. Strings, not Dates, on purpose: a Date would be re-bucketed on the
     * timestamptz→date cast, while the string casts to ::date verbatim and compares against
     * the cookie value by plain equality.
     */
    days: string[]
    /** Rewrite the device row even with no day to credit: its app version changed. */
    refreshDevice?: boolean
  }): Promise<void> {
    const params: unknown[] = []
    const bind = (value: unknown): string => {
      params.push(value)
      return `$${params.length}`
    }

    const ctes: string[] = []
    if (input.days.length > 0 || input.refreshDevice) {
      ctes.push(
        `dev AS (
           INSERT INTO devices (id, os, os_version, app_version, country, created_at, updated_at)
           VALUES (${bind(input.deviceId)}, ${bind(input.os)}, ${bind(input.osVersion)}, ${bind(input.appVersion)}, ${bind(input.country)}, now(), now())
           ON CONFLICT (id) DO UPDATE SET
             os = EXCLUDED.os,
             os_version = EXCLUDED.os_version,
             app_version = EXCLUDED.app_version,
             country = COALESCE(EXCLUDED.country, devices.country),
             updated_at = now())`,
      )
    }
    if (input.days.length > 0) {
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
}
