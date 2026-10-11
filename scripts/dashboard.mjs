#!/usr/bin/env node
// Builds a self-contained analytics dashboard (one HTML file, no network needed to view it).
//
//   node --env-file=<env> scripts/dashboard.mjs [out.html]     default: data/dashboard.html
//
// Reads YM_PG (+ YM_PG_CA / YM_PG_CERT / YM_PG_KEY) like the server; the ymusic_readonly role is
// enough. The production DB listens on the droplet's private address only, so reach it through a
// tunnel; db.ymix.io (the cert's name) is pinned to 127.0.0.1 in this machine's /etc/hosts:
//
//   ssh -N -L 15432:<db-private-ip>:5432 root@<server-ip>
//   YM_PG=postgres://ymusic_readonly:<pw>@db.ymix.io:15432/ymusic
//
// Every day is the DB's own calendar day (+07), the same buckets the ingest writes.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import pg from 'pg'

const DAYS = 90
const out = resolve(process.argv[2] ?? 'data/dashboard.html')

if (!process.env.YM_PG) {
  console.error('YM_PG is not set — run with node --env-file=<env> scripts/dashboard.mjs')
  process.exit(2)
}
const file = (name) => (process.env[name] ? readFileSync(process.env[name], 'utf8') : undefined)
const client = new pg.Client({
  connectionString: process.env.YM_PG,
  ssl: process.env.YM_PG_CA ? { ca: file('YM_PG_CA'), cert: file('YM_PG_CERT'), key: file('YM_PG_KEY') } : undefined,
  options: '-c search_path=app',
})
await client.connect()
const rows = async (sql, params = []) => (await client.query(sql, params)).rows

const [summary] = await rows(`
  SELECT current_date::text AS today,
         (SELECT count(*) FROM devices)::int AS devices,
         (SELECT count(*) FROM daily_activity WHERE day = current_date)::int AS dau,
         (SELECT count(DISTINCT device_id) FROM daily_activity WHERE day > current_date - 7)::int AS wau,
         (SELECT count(DISTINCT device_id) FROM daily_activity WHERE day > current_date - 30)::int AS mau,
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

// Day-N retention per first-seen day; null where day N has not happened yet.
const retention = await rows(
  `WITH cohorts AS (
     SELECT id, date(created_at) AS cohort FROM devices WHERE date(created_at) > current_date - $1::int
   )
   SELECT c.cohort::text AS cohort, count(*)::int AS size,
          CASE WHEN c.cohort + 1 <= current_date THEN count(a1.device_id)::int END AS d1,
          CASE WHEN c.cohort + 7 <= current_date THEN count(a7.device_id)::int END AS d7,
          CASE WHEN c.cohort + 30 <= current_date THEN count(a30.device_id)::int END AS d30
   FROM cohorts c
   LEFT JOIN daily_activity a1 ON a1.device_id = c.id AND a1.day = c.cohort + 1
   LEFT JOIN daily_activity a7 ON a7.device_id = c.id AND a7.day = c.cohort + 7
   LEFT JOIN daily_activity a30 ON a30.device_id = c.id AND a30.day = c.cohort + 30
   GROUP BY c.cohort ORDER BY c.cohort DESC`,
  [60],
)

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
await client.end()

const data = { generatedAt: new Date().toISOString(), summary, daily, retention, versions, platforms, countries }
const html = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8').replace(
  '/*DATA*/null',
  // Inside <script>: no "</script>" or "<!--" may survive in the payload.
  JSON.stringify(data).replace(/</g, '\\u003c'),
)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, html)
console.log(`wrote ${out}`)
