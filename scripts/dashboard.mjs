#!/usr/bin/env node
// Serves the analytics dashboard on this machine; every page load queries the database afresh.
//
//   npm run dashboard          (node --env-file=dashboard.env scripts/dashboard.mjs)
//   → http://127.0.0.1:8790    DASHBOARD_PORT to change; listens on loopback only
//
// Reads YM_PG (+ YM_PG_CA / YM_PG_CERT / YM_PG_KEY) like the server; the ymusic_readonly role is
// enough. The production DB listens on the droplet's private address only, so reach it through a
// tunnel; db.ymix.io (the cert's name) is pinned to 127.0.0.1 in this machine's /etc/hosts:
//
//   ssh -N -L 15432:<db-private-ip>:5432 root@<server-ip>
//   YM_PG=postgres://ymusic_readonly:<pw>@db.ymix.io:15432/ymusic
//
// Every day is the DB's own calendar day (+07), the same buckets the ingest writes.
// ?from=YYYY-MM-DD&to=YYYY-MM-DD picks the charted range (inclusive); the last 90 days by default.
// ?os=<platform> narrows every number to devices whose latest pulse came from that platform.

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import pg from 'pg'

const DEFAULT_DAYS = 90
const MAX_DAYS = 731
const DAY_MS = 86400000
const dayMs = (day) => Date.parse(`${day}T00:00:00Z`)
const isDay = (day) => /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(dayMs(day) || 0).toISOString().startsWith(day)
const PORT = Number(process.env.DASHBOARD_PORT ?? 8790)

if (!process.env.YM_PG) {
  console.error('YM_PG is not set — run with node --env-file=<env> scripts/dashboard.mjs')
  process.exit(2)
}
const file = (name) => (process.env[name] ? readFileSync(process.env[name], 'utf8') : undefined)
const pool = new pg.Pool({
  connectionString: process.env.YM_PG,
  ssl: process.env.YM_PG_CA ? { ca: file('YM_PG_CA'), cert: file('YM_PG_CERT'), key: file('YM_PG_KEY') } : undefined,
  options: '-c search_path=app',
  max: 2,
})
const rows = async (sql, params = []) => (await pool.query(sql, params)).rows

// Returns [from, to, os] validated, or throws a RangeError for the 400 page.
async function range(params, oses) {
  const [today] = await rows(`SELECT current_date::text AS day`)
  let to = params.get('to') || today.day
  let from = params.get('from') || null
  for (const day of [from, to]) {
    if (day != null && !isDay(day)) throw new RangeError(`not a day: ${day}`)
  }
  from ??= new Date(dayMs(to) - (DEFAULT_DAYS - 1) * DAY_MS).toISOString().slice(0, 10)
  if (from > to) [from, to] = [to, from]
  if ((dayMs(to) - dayMs(from)) / DAY_MS >= MAX_DAYS) {
    throw new RangeError(`range is longer than ${MAX_DAYS} days`)
  }
  const os = params.get('os') || null
  if (os != null && !oses.includes(os)) throw new RangeError(`unknown platform: ${os}`)
  return [from, to, os]
}

async function collect(from, to, os, oses) {
  // os is one of the stored values (checked by range), so inlining it as a literal is safe.
  const only = os && `(SELECT id FROM devices WHERE os = '${os.replace(/'/g, "''")}')`
  const dev = (alias = 'devices') => (only ? `(SELECT * FROM devices WHERE id IN ${only}) ${alias}` : `devices ${alias}`)
  const act = (alias = 'daily_activity') =>
    only ? `(SELECT * FROM daily_activity WHERE device_id IN ${only}) ${alias}` : `daily_activity ${alias}`
  const starts = (alias = 'event_app_start') =>
    only ? `(SELECT * FROM event_app_start WHERE device_id IN ${only}) ${alias}` : `event_app_start ${alias}`

  const [summary] = await rows(`
    SELECT current_date::text AS today,
           (SELECT count(*) FROM ${dev()})::int AS devices,
           (SELECT count(*) FROM ${act()} WHERE day = current_date)::int AS dau,
           (SELECT count(DISTINCT device_id) FROM ${act()} WHERE day > current_date - 7)::int AS wau,
           (SELECT count(DISTINCT device_id) FROM ${act()} WHERE day > current_date - 30)::int AS mau,
           (SELECT count(*) FROM ${dev()} WHERE date(created_at) = current_date)::int AS new_today,
           (SELECT count(*) FROM ${starts()} WHERE date(at) = current_date)::int AS launches_today`)

  const [period] = await rows(
    `SELECT $1::text AS "from", $2::text AS "to",
            (SELECT count(DISTINCT device_id) FROM ${act()} WHERE day BETWEEN $1::date AND $2::date)::int AS active,
            (SELECT count(*) FROM ${dev()} WHERE date(created_at) BETWEEN $1::date AND $2::date)::int AS new_devices,
            (SELECT count(*) FROM ${starts()} WHERE date(at) BETWEEN $1::date AND $2::date)::int AS launches`,
    [from, to],
  )

  // wau / mau: distinct devices over the 7 / 30 days ending on that day.
  const daily = await rows(
    `WITH days AS (SELECT generate_series($1::date, $2::date, '1 day')::date AS day)
     SELECT d.day::text AS day,
            (SELECT count(*) FROM ${act('a')} WHERE a.day = d.day)::int AS dau,
            (SELECT count(DISTINCT a.device_id) FROM ${act('a')}
              WHERE a.day > d.day - 7 AND a.day <= d.day)::int AS wau,
            (SELECT count(DISTINCT a.device_id) FROM ${act('a')}
              WHERE a.day > d.day - 30 AND a.day <= d.day)::int AS mau,
            (SELECT count(*) FROM ${dev('v')} WHERE date(v.created_at) = d.day)::int AS new_devices,
            (SELECT count(*) FROM ${starts('e')} WHERE date(e.at) = d.day)::int AS launches
     FROM days d ORDER BY d.day`,
    [from, to],
  )

  // Firebase-style retention, ending yesterday (today is still partial). Devices are grouped by
  // their first day; day N / week N of a device count from ITS first day, and only devices whose
  // day N has already ended are counted for it.
  const [{ end }] = await rows(`SELECT (current_date - 1)::text AS "end"`)
  const RETENTION_DAYS = 42
  const retentionDaily = await rows(
    `WITH c AS (SELECT id, date(created_at) AS first FROM ${dev()}
                WHERE date(created_at) BETWEEN $1::date - ($2::int - 1) AND $1::date)
     SELECT n AS day,
            (SELECT count(*) FROM c WHERE c.first + n <= $1::date)::int AS eligible,
            (SELECT count(*) FROM c WHERE c.first + n <= $1::date
               AND EXISTS (SELECT 1 FROM ${act('a')} WHERE a.device_id = c.id AND a.day = c.first + n))::int AS active
     FROM generate_series(0, $2::int - 1) n`,
    [end, RETENTION_DAYS],
  )

  // Cohort k (0 = newest) is the 7 days ending 7k days before the end.
  const COHORT_WEEKS = 6
  const cohortRows = await rows(
    `WITH c AS (
       SELECT id, date(created_at) AS first, ($1::date - date(created_at)) / 7 AS k
       FROM ${dev()} WHERE date(created_at) BETWEEN $1::date - (7 * $2::int - 1) AND $1::date
     )
     SELECT c.k, -1 AS week, count(*)::int AS devices FROM c GROUP BY c.k
     UNION ALL
     SELECT c.k, ((a.day - c.first) / 7)::int, count(DISTINCT a.device_id)::int
     FROM c JOIN ${act('a')} ON a.device_id = c.id AND a.day >= c.first AND a.day <= $1::date
       AND a.day < c.first + 7 * $2::int
     GROUP BY 1, 2`,
    [end, COHORT_WEEKS],
  )
  const endMs = dayMs(end)
  const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)
  const cohorts = Array.from({ length: COHORT_WEEKS }, (_, k) => {
    const startMs = endMs - (7 * k + 6) * DAY_MS
    const size = cohortRows.find((r) => r.k === k && r.week === -1)?.devices ?? 0
    const weeks = Array.from({ length: COHORT_WEEKS }, (_, week) =>
      startMs + week * 7 * DAY_MS <= endMs ? (cohortRows.find((r) => r.k === k && r.week === week)?.devices ?? 0) : null,
    )
    return { from: isoDay(startMs), to: isoDay(startMs + 6 * DAY_MS), size, weeks }
  })
  const retention = { end, daily: retentionDaily, cohorts }

  // Breakdowns over devices active in the range.
  const active = `id IN (SELECT device_id FROM ${act()} WHERE day BETWEEN $1::date AND $2::date)`
  const versions = await rows(
    `SELECT os, app_version AS version, count(*)::int AS devices FROM ${dev()} WHERE ${active}
     GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`,
    [from, to],
  )
  const platforms = await rows(
    `SELECT os, count(*)::int AS devices FROM ${dev()} WHERE ${active} GROUP BY 1 ORDER BY 2 DESC`,
    [from, to],
  )
  const countries = await rows(
    `SELECT coalesce(country, '—') AS country, count(*)::int AS devices FROM ${dev()} WHERE ${active}
     GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
    [from, to],
  )
  return { os, oses, summary, period, daily, retention, versions, platforms, countries }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname !== '/') {
    res.writeHead(404).end()
    return
  }
  try {
    const oses = (await rows(`SELECT DISTINCT os FROM devices ORDER BY os`)).map((r) => r.os)
    const data = await collect(...(await range(url.searchParams, oses)), oses)
    // Read per request, so an edited template shows on reload.
    const html = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8').replace(
      '/*DATA*/null',
      // Inside <script>: no "</script>" or "<!--" may survive in the payload. A function, so "$&"
      // in the data is not read as a replacement pattern.
      () => JSON.stringify(data).replace(/</g, '\\u003c'),
    )
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html)
  } catch (error) {
    if (error instanceof RangeError) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(`Bad range: ${error.message}`)
      return
    }
    console.error(error)
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(`Query failed: ${error.message}`)
  }
}).listen(PORT, '127.0.0.1', () => console.log(`dashboard on http://127.0.0.1:${PORT}`))
