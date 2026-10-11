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
// Every day is the DB's own calendar day (+07), the same buckets the ingest writes. Closed days
// come from the server's nightly rollup tables; only today is read from the raw tables.
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
  const onOs = (column) => (os ? `${column} = '${os.replace(/'/g, "''")}'` : 'true')
  const ofOs = os ? `device_id IN (SELECT id FROM devices WHERE ${onOs('os')})` : 'true'
  const [{ today, end }] = await rows(`SELECT current_date::text AS today, (current_date - 1)::text AS "end"`)

  // Today is still open, so it is read live; last_active >= d means "active on d or later".
  const [live] = await rows(`
    SELECT current_date::text AS day,
           (SELECT count(*) FROM devices WHERE last_active >= current_date AND ${onOs('os')})::int AS dau,
           (SELECT count(*) FROM devices WHERE last_active > current_date - 7 AND ${onOs('os')})::int AS wau,
           (SELECT count(*) FROM devices WHERE last_active > current_date - 30 AND ${onOs('os')})::int AS mau,
           (SELECT count(*) FROM devices
             WHERE created_at >= current_date::timestamptz AND ${onOs('os')})::int AS new_devices,
           (SELECT count(*) FROM event_app_start
             WHERE at >= current_date::timestamptz AND ${ofOs})::int AS launches`)

  // Closed days come from the nightly rollup (ymusic-server src/stats.ts).
  const closed = await rows(
    `SELECT d::date::text AS day,
            coalesce(sum(s.dau), 0)::int AS dau, coalesce(sum(s.wau), 0)::int AS wau,
            coalesce(sum(s.mau), 0)::int AS mau, coalesce(sum(s.new_devices), 0)::int AS new_devices,
            coalesce(sum(s.launches), 0)::int AS launches
     FROM generate_series($1::date, LEAST($2::date, current_date - 1), '1 day') d
     LEFT JOIN stats_day s ON s.day = d::date AND ${onOs('s.os')}
     GROUP BY d ORDER BY d`,
    [from, to],
  )
  const daily = to >= today ? [...closed, live] : closed
  const [{ before }] = await rows(
    `SELECT coalesce(sum(new_devices), 0)::int AS before FROM stats_day WHERE ${onOs('os')}`,
  )
  const summary = {
    today,
    dau: live.dau,
    wau: live.wau,
    mau: live.mau,
    new_today: live.new_devices,
    launches_today: live.launches,
    devices: before + live.new_devices,
  }

  // Unique devices over a range are exact only when it ends today (last_active); a past range
  // would need the raw activity, which is too much to scan per page view.
  const endsToday = to === today
  const [{ active }] = endsToday
    ? await rows(`SELECT count(*)::int AS active FROM devices WHERE last_active >= $1::date AND ${onOs('os')}`, [from])
    : [{ active: null }]
  const sum = (key) => daily.reduce((total, day) => total + day[key], 0)
  const period = { from, to, active, new_devices: sum('new_devices'), launches: sum('launches') }

  // Retention ends yesterday. Day N / week N count from each device's own first day; a first day
  // only counts toward N once its day N has ended.
  const RETENTION_DAYS = 42
  const retentionDaily = await rows(
    `SELECT g.n AS day,
            (SELECT coalesce(sum(new_devices), 0) FROM stats_day
              WHERE day > $1::date - $2::int AND day <= $1::date - g.n AND ${onOs('os')})::int AS eligible,
            (SELECT coalesce(sum(active), 0) FROM stats_retention r
              WHERE r.n = g.n AND first_day > $1::date - $2::int AND first_day <= $1::date - g.n
                AND ${onOs('os')})::int AS active
     FROM generate_series(0, $2::int - 1) g(n)`,
    [end, RETENTION_DAYS],
  )

  // Cohort k (0 = newest) is the 7 days ending 7k days before the end.
  const COHORT_WEEKS = 6
  const cohortRows = await rows(
    `SELECT ($1::date - day) / 7 AS k, -1 AS week, sum(new_devices)::int AS devices FROM stats_day
     WHERE day > $1::date - 7 * $2::int AND day <= $1::date AND ${onOs('os')} GROUP BY 1
     UNION ALL
     SELECT ($1::date - first_day) / 7, week, sum(active)::int FROM stats_retention_week
     WHERE first_day > $1::date - 7 * $2::int AND first_day <= $1::date AND week < $2::int AND ${onOs('os')}
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

  // Breakdowns over devices active in the range, by their current attributes: one scan, three
  // groupings. GROUPING() bits are (os, app_version, country), 1 = rolled up.
  let versions = null
  let platforms = null
  let countries = null
  if (endsToday) {
    const groups = await rows(
      `SELECT os, app_version AS version, coalesce(country, '—') AS country, count(*)::int AS devices,
              GROUPING(os, app_version, country) AS g
       FROM devices WHERE last_active >= $1::date AND ${onOs('os')}
       GROUP BY GROUPING SETS ((os, app_version), (os), (country))
       ORDER BY devices DESC`,
      [from],
    )
    versions = groups.filter((r) => r.g === 1).slice(0, 20)
    platforms = groups.filter((r) => r.g === 3)
    countries = groups.filter((r) => r.g === 6).slice(0, 15)
  }
  return { os, oses, summary, period, daily, retention, versions, platforms, countries }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname !== '/') {
    res.writeHead(404).end()
    return
  }
  try {
    const oses = (await rows(`SELECT DISTINCT os FROM stats_day ORDER BY os`)).map((r) => r.os)
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
