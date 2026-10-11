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

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import pg from 'pg'

const DAYS = 90
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

async function collect() {
  const [summary] = await rows(`
    SELECT current_date::text AS today,
           (SELECT count(*) FROM devices)::int AS devices,
           (SELECT count(*) FROM daily_activity WHERE day = current_date)::int AS dau,
           (SELECT count(DISTINCT device_id) FROM daily_activity WHERE day > current_date - 7)::int AS wau,
           (SELECT count(DISTINCT device_id) FROM daily_activity WHERE day > current_date - 30)::int AS mau,
           (SELECT count(DISTINCT device_id) FROM daily_activity WHERE day > current_date - 90)::int AS active90,
           (SELECT count(*) FROM devices WHERE date(created_at) = current_date)::int AS new_today,
           (SELECT count(*) FROM event_app_start WHERE date(at) = current_date)::int AS launches_today`)

  const daily = await rows(
    `WITH days AS (SELECT generate_series(current_date - ($1::int - 1), current_date, '1 day')::date AS day)
     SELECT d.day::text AS day,
            (SELECT count(*) FROM daily_activity a WHERE a.day = d.day)::int AS dau,
            (SELECT count(DISTINCT a.device_id) FROM daily_activity a
              WHERE a.day > d.day - 30 AND a.day <= d.day)::int AS mau,
            (SELECT count(*) FROM devices v WHERE date(v.created_at) = d.day)::int AS new_devices,
            (SELECT count(*) FROM event_app_start e WHERE date(e.at) = d.day)::int AS launches
     FROM days d ORDER BY d.day`,
    [DAYS],
  )

  // Weekly cohorts (Monday-start week of first seen), Firebase-style: week N of a device is days
  // [7N, 7N+6] after ITS first day. A week is null until the cohort's first day could reach it.
  const COHORT_WEEKS = 6
  const cohortRows = await rows(
    `WITH c AS (
       SELECT id, date(created_at) AS first, date_trunc('week', date(created_at))::date AS cohort
       FROM devices WHERE date(created_at) >= date_trunc('week', current_date)::date - 7 * ($1::int - 1)
     )
     SELECT c.cohort::text AS cohort, -1 AS week, count(*)::int AS devices FROM c GROUP BY c.cohort
     UNION ALL
     SELECT c.cohort::text, ((a.day - c.first) / 7)::int, count(DISTINCT a.device_id)::int
     FROM c JOIN daily_activity a ON a.device_id = c.id AND a.day >= c.first AND a.day < c.first + 7 * $1::int
     GROUP BY 1, 2`,
    [COHORT_WEEKS],
  )
  const retention = [...new Set(cohortRows.map((r) => r.cohort))].sort().reverse().map((cohort) => {
    const size = cohortRows.find((r) => r.cohort === cohort && r.week === -1)?.devices ?? 0
    const start = new Date(`${cohort}T00:00:00Z`)
    const weeks = Array.from({ length: COHORT_WEEKS }, (_, week) => {
      const reachable = new Date(start.getTime() + week * 7 * 86400000).toISOString().slice(0, 10) <= summary.today
      return reachable ? (cohortRows.find((r) => r.cohort === cohort && r.week === week)?.devices ?? 0) : null
    })
    return { cohort, size, weeks }
  })

  // Breakdowns over devices active in the last 30 days.
  const active30 = `id IN (SELECT device_id FROM daily_activity WHERE day > current_date - 30)`
  const versions = await rows(
    `SELECT os, app_version AS version, count(*)::int AS devices FROM devices WHERE ${active30}
     GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`,
  )
  const platforms = await rows(
    `SELECT os, count(*)::int AS devices FROM devices WHERE ${active30} GROUP BY 1 ORDER BY 2 DESC`,
  )
  const countries = await rows(
    `SELECT coalesce(country, '—') AS country, count(*)::int AS devices FROM devices WHERE ${active30}
     GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
  )
  return { generatedAt: new Date().toISOString(), summary, daily, retention, versions, platforms, countries }
}

createServer(async (req, res) => {
  if (req.url !== '/') {
    res.writeHead(404).end()
    return
  }
  try {
    const data = await collect()
    // Read per request, so an edited template shows on reload.
    const html = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8').replace(
      '/*DATA*/null',
      // Inside <script>: no "</script>" or "<!--" may survive in the payload. A function, so "$&"
      // in the data is not read as a replacement pattern.
      () => JSON.stringify(data).replace(/</g, '\\u003c'),
    )
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html)
  } catch (error) {
    console.error(error)
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(`Query failed: ${error.message}`)
  }
}).listen(PORT, '127.0.0.1', () => console.log(`dashboard on http://127.0.0.1:${PORT}`))
