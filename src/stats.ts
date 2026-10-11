import type { FastifyBaseLogger } from 'fastify'
import type pg from 'pg'
import { PARTITIONS } from './db.js'

/** Closed days recomputed every run: late pulses (an offline backlog) still land in them. */
const RECOMPUTE_DAYS = 7
/** The retention window the dashboard shows: day 0..41, six weekly cohorts. */
export const RETENTION_DAYS = 42
/** 00:15 in +07, the analytics day (dayOf in routes/pulse.ts), as minutes past 00:00 UTC. */
const RUN_AT_UTC_MINUTES = 17 * 60 + 15
const BOOT_DELAY_MS = 10_000

// One closed day per platform. dau/wau/mau come from one pass over the 30 days ending on it:
// each device's latest active day in the window says which of the three it counts toward.
const DAY_ROLLUP = `
INSERT INTO stats_day (day, os, dau, wau, mau, new_devices, launches)
SELECT $1::date, os, sum(dau), sum(wau), sum(mau), sum(new_devices), sum(launches)
FROM (
  SELECT v.os,
         count(*) FILTER (WHERE m.last = $1::date) AS dau,
         count(*) FILTER (WHERE m.last > $1::date - 7) AS wau,
         count(*) AS mau, 0 AS new_devices, 0 AS launches
  FROM (SELECT device_id, max(day) AS last FROM daily_activity
        WHERE day > $1::date - 30 AND day <= $1::date GROUP BY device_id) m
  JOIN devices v ON v.id = m.device_id
  GROUP BY v.os
  UNION ALL
  SELECT os, 0, 0, 0, count(*), 0 FROM devices
  WHERE created_at >= $1::date::timestamptz AND created_at < ($1::date + 1)::timestamptz
  GROUP BY os
  UNION ALL
  SELECT v.os, 0, 0, 0, 0, count(*) FROM event_app_start e JOIN devices v ON v.id = e.device_id
  WHERE e.at >= $1::date::timestamptz AND e.at < ($1::date + 1)::timestamptz
  GROUP BY v.os
) x
GROUP BY os`

// Every device first seen in the window ending $1, with each later day it was active. Replaces
// the whole window; older cohorts are frozen.
const RETENTION_ROLLUP = `
WITH c AS (
  SELECT id, os, date(created_at) AS first FROM devices
  WHERE created_at >= ($1::date - ($2::int - 1))::timestamptz AND created_at < ($1::date + 1)::timestamptz
), a AS MATERIALIZED (
  SELECT c.first, c.os, a.day - c.first AS n, a.device_id
  FROM c JOIN daily_activity a ON a.device_id = c.id
  WHERE a.day >= c.first AND a.day >= $1::date - ($2::int - 1) AND a.day <= $1::date
), weeks AS (
  INSERT INTO stats_retention_week (first_day, os, week, active)
  SELECT first, os, n / 7, count(DISTINCT device_id) FROM a GROUP BY 1, 2, 3
)
INSERT INTO stats_retention (first_day, os, n, active)
SELECT first, os, n, count(*) FROM a GROUP BY 1, 2, 3`

/**
 * Brings the rollups up to yesterday: every day since the last rolled-up one (all of history on
 * the first run), plus the last [RECOMPUTE_DAYS] again. Returns false when another process holds
 * the run.
 */
export async function rollup(pool: pg.Pool, log: FastifyBaseLogger): Promise<boolean> {
  const client = await pool.connect()
  try {
    const { rows } = await client.query(`SELECT pg_try_advisory_lock(hashtext('ymusic-stats')) AS locked`)
    if (!rows[0].locked) {
      client.release()
      return false
    }
    const started = Date.now()
    await client.query(PARTITIONS)
    const days = await client.query<{ day: string }>(
      `SELECT d::date::text AS day FROM generate_series(
         LEAST(current_date - $1::int,
               COALESCE((SELECT max(day) + 1 FROM stats_day), (SELECT min(day) FROM daily_activity), current_date)),
         current_date - 1, '1 day') d`,
      [RECOMPUTE_DAYS],
    )
    for (const { day } of days.rows) {
      await client.query('BEGIN')
      await client.query('DELETE FROM stats_day WHERE day = $1', [day])
      await client.query(DAY_ROLLUP, [day])
      await client.query('COMMIT')
    }
    const window = [days.rows.at(-1)?.day, RETENTION_DAYS]
    await client.query('BEGIN')
    await client.query(`DELETE FROM stats_retention WHERE first_day > $1::date - $2::int`, window)
    await client.query(`DELETE FROM stats_retention_week WHERE first_day > $1::date - $2::int`, window)
    await client.query(RETENTION_ROLLUP, window)
    await client.query('COMMIT')
    await client.query(`SELECT pg_advisory_unlock(hashtext('ymusic-stats'))`)
    client.release()
    log.info({ days: days.rows.length, ms: Date.now() - started }, 'stats rollup')
    return true
  } catch (error) {
    client.release(true) // closing the session rolls back and drops the lock
    throw error
  }
}

/** Runs [rollup] shortly after boot, then daily at 00:15 +07. Returns the stop function. */
export function scheduleRollup(pool: pg.Pool, log: FastifyBaseLogger): () => void {
  let timer: NodeJS.Timeout
  let stopped = false
  const run = () => {
    rollup(pool, log)
      .catch((error: unknown) => log.error({ err: error }, 'stats rollup failed — retried at the next run'))
      .finally(() => {
        if (!stopped) timer = setTimeout(run, untilNextRun())
      })
  }
  timer = setTimeout(run, BOOT_DELAY_MS)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

function untilNextRun(now = Date.now()): number {
  const midnightUtc = Math.floor(now / 86_400_000) * 86_400_000
  let next = midnightUtc + RUN_AT_UTC_MINUTES * 60_000
  if (next <= now) next += 86_400_000
  return next - now
}
