import type pg from 'pg'

// Every day is the DB's own calendar day (+07), the same buckets the ingest writes. Closed days
// come from the nightly rollup tables (../stats.ts); only today is read from the raw tables.

const DEFAULT_DAYS = 90
const MAX_DAYS = 731
const RETENTION_DAYS = 42
const COHORT_WEEKS = 6
const DAY_MS = 86_400_000

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`)
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const isDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && isoDay(dayMs(day) || 0) === day

/** A query the caller got wrong: answered 400 with this message. */
export class BadQuery extends Error {}

export interface Query {
  from?: string | undefined
  to?: string | undefined
  os?: string | undefined
}

interface Day {
  day: string
  dau: number
  wau: number
  mau: number
  new_devices: number
  launches: number
}

interface Group {
  os: string | null
  version: string | null
  country: string
  devices: number
  g: number
}

export async function analytics(pool: pg.Pool, query: Query) {
  const rows = async <T>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[]
  const [clock] = await rows<{ today: string; end: string }>(
    `SELECT current_date::text AS today, (current_date - 1)::text AS "end"`,
  )
  const { today, end } = clock!
  const oses = (await rows<{ os: string }>(`SELECT DISTINCT os FROM stats_day ORDER BY os`)).map((r) => r.os)

  let to = query.to || today
  let from = query.from || null
  for (const day of [from, to]) {
    if (day != null && !isDay(day)) throw new BadQuery(`not a day: ${day}`)
  }
  from ??= isoDay(dayMs(to) - (DEFAULT_DAYS - 1) * DAY_MS)
  if (from > to) [from, to] = [to, from]
  if ((dayMs(to) - dayMs(from)) / DAY_MS >= MAX_DAYS) throw new BadQuery(`range is longer than ${MAX_DAYS} days`)
  const os = query.os || null
  if (os != null && !oses.includes(os)) throw new BadQuery(`unknown platform: ${os}`)

  // os is one of the stored values (checked above), so inlining it as a literal is safe.
  const onOs = (column: string) => (os ? `${column} = '${os.replace(/'/g, "''")}'` : 'true')
  const ofOs = os ? `device_id IN (SELECT id FROM devices WHERE ${onOs('os')})` : 'true'

  // Today is still open, so it is read live; last_active >= d means "active on d or later".
  const [live] = await rows<Day>(`
    SELECT current_date::text AS day,
           (SELECT count(*) FROM devices WHERE last_active >= current_date AND ${onOs('os')})::int AS dau,
           (SELECT count(*) FROM devices WHERE last_active > current_date - 7 AND ${onOs('os')})::int AS wau,
           (SELECT count(*) FROM devices WHERE last_active > current_date - 30 AND ${onOs('os')})::int AS mau,
           (SELECT count(*) FROM devices
             WHERE created_at >= current_date::timestamptz AND ${onOs('os')})::int AS new_devices,
           (SELECT count(*) FROM event_app_start
             WHERE at >= current_date::timestamptz AND ${ofOs})::int AS launches`)
  const liveToday = live!

  const closed = await rows<Day>(
    `SELECT d::date::text AS day,
            coalesce(sum(s.dau), 0)::int AS dau, coalesce(sum(s.wau), 0)::int AS wau,
            coalesce(sum(s.mau), 0)::int AS mau, coalesce(sum(s.new_devices), 0)::int AS new_devices,
            coalesce(sum(s.launches), 0)::int AS launches
     FROM generate_series($1::date, LEAST($2::date, current_date - 1), '1 day') d
     LEFT JOIN stats_day s ON s.day = d::date AND ${onOs('s.os')}
     GROUP BY d ORDER BY d`,
    [from, to],
  )
  const daily = to >= today ? [...closed, liveToday] : closed
  const [{ before } = { before: 0 }] = await rows<{ before: number }>(
    `SELECT coalesce(sum(new_devices), 0)::int AS before FROM stats_day WHERE ${onOs('os')}`,
  )
  const summary = {
    today,
    dau: liveToday.dau,
    wau: liveToday.wau,
    mau: liveToday.mau,
    new_today: liveToday.new_devices,
    launches_today: liveToday.launches,
    devices: before + liveToday.new_devices,
  }

  // Unique devices over a range are exact only when it ends today (last_active); a past range
  // would need the raw activity, which is too much to scan per page view.
  const endsToday = to === today
  const active = endsToday
    ? (
        await rows<{ active: number }>(
          `SELECT count(*)::int AS active FROM devices WHERE last_active >= $1::date AND ${onOs('os')}`,
          [from],
        )
      )[0]!.active
    : null
  const sum = (key: 'new_devices' | 'launches') => daily.reduce((total, day) => total + day[key], 0)
  const period = { from, to, active, new_devices: sum('new_devices'), launches: sum('launches') }

  // Retention ends yesterday. Day N / week N count from each device's own first day; a first day
  // only counts toward N once its day N has ended.
  const retentionDaily = await rows<{ day: number; eligible: number; active: number }>(
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
  const cohortRows = await rows<{ k: number; week: number; devices: number }>(
    `SELECT ($1::date - day) / 7 AS k, -1 AS week, sum(new_devices)::int AS devices FROM stats_day
     WHERE day > $1::date - 7 * $2::int AND day <= $1::date AND ${onOs('os')} GROUP BY 1
     UNION ALL
     SELECT ($1::date - first_day) / 7, week, sum(active)::int FROM stats_retention_week
     WHERE first_day > $1::date - 7 * $2::int AND first_day <= $1::date AND week < $2::int AND ${onOs('os')}
     GROUP BY 1, 2`,
    [end, COHORT_WEEKS],
  )
  const endMs = dayMs(end)
  const cohorts = Array.from({ length: COHORT_WEEKS }, (_, k) => {
    const startMs = endMs - (7 * k + 6) * DAY_MS
    const size = cohortRows.find((r) => r.k === k && r.week === -1)?.devices ?? 0
    const weeks = Array.from({ length: COHORT_WEEKS }, (_, week) =>
      startMs + week * 7 * DAY_MS <= endMs ? (cohortRows.find((r) => r.k === k && r.week === week)?.devices ?? 0) : null,
    )
    return { from: isoDay(startMs), to: isoDay(startMs + 6 * DAY_MS), size, weeks }
  })

  // Breakdowns over devices active in the range, by their current attributes: one scan, three
  // groupings. GROUPING() bits are (os, version, country), 1 = rolled up. Builds that predate
  // x-app-ver-name show as "build <code>".
  let breakdowns: { versions: Group[]; platforms: Group[]; countries: Group[] } | null = null
  if (endsToday) {
    const groups = await rows<Group>(
      `SELECT os, version, country, count(*)::int AS devices, GROUPING(os, version, country) AS g
       FROM (SELECT os, coalesce(app_version_name, 'build ' || app_version) AS version,
                    coalesce(country, '—') AS country
             FROM devices WHERE last_active >= $1::date AND ${onOs('os')}) d
       GROUP BY GROUPING SETS ((version), (os), (country))
       ORDER BY devices DESC`,
      [from],
    )
    breakdowns = {
      versions: groups.filter((r) => r.g === 5).slice(0, 20),
      platforms: groups.filter((r) => r.g === 3),
      countries: groups.filter((r) => r.g === 6).slice(0, 15),
    }
  }

  return {
    os,
    oses,
    summary,
    period,
    daily,
    retention: { end, daily: retentionDaily, cohorts },
    versions: breakdowns?.versions ?? null,
    platforms: breakdowns?.platforms ?? null,
    countries: breakdowns?.countries ?? null,
  }
}
