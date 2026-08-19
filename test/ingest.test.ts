import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.js'

/**
 * Live-database half of the pulse tests: runs only when YM_PG points somewhere (npm run
 * test:live, with the ymusic-docker-configs stack up). The plain `npm test` never touches it.
 */
const DSN = process.env.YM_PG

describe.runIf(!!DSN)('POST /v1/pulse against live postgres', () => {
  let app: Awaited<ReturnType<typeof buildServer>>
  let db: pg.Client
  const device = randomUUID()

  const sslFile = (name: 'YM_PG_CA' | 'YM_PG_CERT' | 'YM_PG_KEY') => {
    const path = process.env[name]
    return path ? readFileSync(path, 'utf8') : undefined
  }

  beforeAll(async () => {
    app = await buildServer({
      pg: {
        dsn: DSN!,
        caFile: process.env.YM_PG_CA,
        certFile: process.env.YM_PG_CERT,
        keyFile: process.env.YM_PG_KEY,
      },
      cookieSecret: 'test-secret',
    })
    await app.ready()
    db = new pg.Client({
      connectionString: DSN,
      ssl: process.env.YM_PG_CA
        ? { ca: sslFile('YM_PG_CA'), cert: sslFile('YM_PG_CERT'), key: sslFile('YM_PG_KEY') }
        : undefined,
      options: '-c search_path=app',
    })
    await db.connect()
  })

  afterAll(async () => {
    await db.query('DELETE FROM event_app_start WHERE device_id = $1', [device])
    await db.query('DELETE FROM event_app_update WHERE device_id = $1', [device])
    await db.query('DELETE FROM daily_activity WHERE device_id = $1', [device])
    await db.query('DELETE FROM devices WHERE id = $1', [device])
    await db.end()
    await app.close()
  })

  const post = (events: unknown[], cookie?: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/pulse',
      headers: {
        'x-os': 'windows',
        'x-os-ver': '11',
        'x-app-ver': '1233',
        'x-device-id': device,
        'cf-ipcountry': 'VN',
        ...(cookie ? { cookie } : {}),
      },
      payload: { events },
    })

  it('writes the device, the day credit, and the event rows in one batch', async () => {
    const res = await post([
      { name: 'app_start', at: Date.now(), props: { cold: 'true' } },
      { name: 'not_defined', at: Date.now() }, // allowlist drops this one
      { name: 'app_start', at: 'garbage' }, // and this one
    ])

    expect(res.statusCode).toBe(204)
    expect(res.headers['set-cookie']).toMatch(/^act=/)

    const dev = await db.query('SELECT os, os_version, app_version, country FROM devices WHERE id = $1', [device])
    expect(dev.rows[0]).toEqual({ os: 'windows', os_version: '11', app_version: 1233, country: 'VN' })
    const days = await db.query('SELECT count(*)::int AS n FROM daily_activity WHERE device_id = $1', [device])
    expect(days.rows[0].n).toBe(1)
    const events = await db.query('SELECT count(*)::int AS n FROM event_app_start WHERE device_id = $1', [device])
    expect(events.rows[0].n).toBe(1)
  })

  it('the activity cookie skips the device write but never the events', async () => {
    const first = await post([{ name: 'app_start', at: Date.now() }])
    const cookie = (first.headers['set-cookie'] as string).split(';')[0]
    const before = await db.query('SELECT updated_at FROM devices WHERE id = $1', [device])

    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await post([{ name: 'app_start', at: Date.now() }], cookie)

    expect(second.statusCode).toBe(204)
    const after = await db.query('SELECT updated_at FROM devices WHERE id = $1', [device])
    expect(after.rows[0].updated_at).toEqual(before.rows[0].updated_at) // upsert skipped
    const events = await db.query('SELECT count(*)::int AS n FROM event_app_start WHERE device_id = $1', [device])
    expect(events.rows[0].n).toBeGreaterThanOrEqual(3) // events always land
  })

  it('the watermark credits only days after it — an older event re-credits nothing', async () => {
    const first = await post([{ name: 'app_start', at: Date.now() }])
    const cookie = (first.headers['set-cookie'] as string).split(';')[0]
    const before = await db.query('SELECT count(*)::int AS n FROM daily_activity WHERE device_id = $1', [device])

    // Yesterday < the cookie's last credited day: filtered out, no device/activity write at all.
    const res = await post([{ name: 'app_start', at: Date.now() - 24 * 60 * 60 * 1000 }], cookie)

    expect(res.statusCode).toBe(204)
    const after = await db.query('SELECT count(*)::int AS n FROM daily_activity WHERE device_id = $1', [device])
    expect(after.rows[0].n).toBe(before.rows[0].n)
    // The watermark did not move, so it is not re-sent either.
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('an event handler turns props into typed columns, and rejects malformed ones', async () => {
    const res = await post([
      { name: 'app_update', at: Date.now(), props: { fromVersion: '1233', toVersion: '1234' } },
      { name: 'app_update', at: Date.now(), props: { fromVersion: 'not-a-number' } }, // handler drops
    ])

    expect(res.statusCode).toBe(204)
    const rows = await db.query(
      'SELECT os, from_version, to_version FROM event_app_update WHERE device_id = $1',
      [device],
    )
    expect(rows.rows).toEqual([{ os: 'windows', from_version: 1233, to_version: 1234 }])
  })

  it('a tampered cookie falls back to the normal write path', async () => {
    const res = await post([{ name: 'app_start', at: Date.now() }], 'act=2099-01-01.forgedsig')

    expect(res.statusCode).toBe(204) // and the day credit happened via ON CONFLICT as usual
    const days = await db.query('SELECT count(*)::int AS n FROM daily_activity WHERE device_id = $1', [device])
    expect(days.rows[0].n).toBe(1)
  })
})
