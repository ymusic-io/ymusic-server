import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { EVENTS, type AcceptedEvent, type EventContext } from '../db.js'
import { header } from '../headers.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COUNTRY = /^[a-z]{2}$/i
const VERSION_NAME = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/
const BUNDLE_VERSION = /^[1-9][0-9]{0,8}$/

/** Junk device clocks must not pollute history: anything older than this is dropped. */
const MAX_EVENT_AGE_MS = 60 * 24 * 60 * 60 * 1000

/** Wire contract: the client chunks its queue to this many events per pulse; more is a 413. */
const MAX_EVENTS_PER_BATCH = 15

/**
 * The advisory write-skip cookie, `<day>.<appVersion>.<engineJs>.<playerJs>`: the last day this
 * device's activity was credited and the app + bundle versions the device row last recorded (`-`
 * for a bundle not yet seen). A cookie from before the bundle fields reads as "bundles unknown".
 */
const ACTIVITY_COOKIE = 'act'
const ACTIVITY_VALUE = /^(\d{4}-\d{2}-\d{2})\.(-?\d+)(?:\.(\d+|-)\.(\d+|-))?$/
const ACTIVITY_COOKIE_MAX_AGE_S = 2 * 24 * 60 * 60

/**
 * THE definition of a calendar "day" for analytics: the DATABASE's timezone, +07 (Asia/
 * Ho_Chi_Minh, pinned with -c timezone= in ymusic-docker-configs/compose.yml). Deriving buckets
 * in the same zone the DB casts in means current_date, date(created_at) and daily_activity.day
 * all agree without any AT TIME ZONE in the queries. +07 has never had DST, so a fixed offset
 * is exact. Change one side, change the other.
 */
const DAY_OFFSET_MS = 7 * 60 * 60 * 1000

function dayOf(at: Date): string {
  return new Date(at.getTime() + DAY_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * Anonymous usage pulses. The client batches on disk and posts at most every half hour; context
 * (os, app version, device uuid) rides the common headers, country comes from the proxy's geo
 * header, and each event carries its own `at` so a backlog batch credits the day the events
 * actually happened.
 *
 * Bad input — no uuid, unknown names, ancient timestamps — is logged and dropped with a 204:
 * never teach a client to retry garbage. A DATABASE failure is a 500 on purpose: the client
 * keeps its disk queue and retries next window. Without a configured database this stays the
 * log-only endpoint it always was.
 */
export default async function pulseRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/pulse', async (req, reply) => {
    const body = req.body as { events?: unknown } | null
    const raw = Array.isArray(body?.events) ? body.events : []
    if (raw.length > MAX_EVENTS_PER_BATCH) {
      // Rejected whole, nothing processed: a conforming client never sends this, so it is a
      // client bug to surface loudly, not an input to accommodate.
      req.log.warn({ count: raw.length, device: header(req.headers['x-device-id']) }, 'pulse batch over the cap')
      return reply.code(413).send()
    }
    const now = Date.now()

    const deviceId = header(req.headers['x-device-id'])?.toLowerCase()
    const rawCountry = header(req.headers['cf-ipcountry'])
    const rawVersionName = header(req.headers['x-app-ver-name'])
    const ctx: EventContext = {
      os: (header(req.headers['x-os']) ?? '').toLowerCase(),
      osVersion: header(req.headers['x-os-ver']) ?? '',
      appVersion: Number.parseInt(header(req.headers['x-app-ver']) ?? '', 10) || -1,
      appVersionName: VERSION_NAME.test(rawVersionName ?? '') ? rawVersionName! : null,
      country: rawCountry && COUNTRY.test(rawCountry) ? rawCountry.toUpperCase() : null,
      engineJsVersion: bundleVersion(header(req.headers['x-engine-js-ver'])),
      playerJsVersion: bundleVersion(header(req.headers['x-player-js-ver'])),
    }

    const accepted: AcceptedEvent[] = []
    const days = new Set<string>()
    let dropped = 0
    for (const item of raw) {
      const name = typeof (item as { name?: unknown })?.name === 'string' ? (item as { name: string }).name : ''
      const at = (item as { at?: unknown })?.at
      const def = EVENTS[name]
      if (!def || typeof at !== 'number' || !Number.isFinite(at) || at < now - MAX_EVENT_AGE_MS) {
        dropped++
        continue
      }
      // The event's own handler turns the wire props + context into its columns; null = malformed.
      const values = def.values(stringProps((item as { props?: unknown }).props), ctx)
      if (values === null) {
        dropped++
        continue
      }
      const clamped = new Date(Math.min(at, now)) // a future clock credits today, not tomorrow
      accepted.push({ name, at: clamped, values })
      days.add(dayOf(clamped))
    }

    req.log.info({ count: raw.length, accepted: accepted.length, dropped, device: deviceId }, 'pulse')
    if (!app.analytics || !deviceId || !UUID.test(deviceId) || accepted.length === 0) {
      return reply.code(204).send()
    }

    // The signed cookie is the server's own watermark: the last day it credited for this
    // device. Only days AFTER it need crediting ('YYYY-MM-DD' compares as text; the client
    // sends oldest→newest, so a backlog batch spanning days credits exactly the uncovered
    // tail). Absent or invalid reads as "credit everything" — ON CONFLICT stays the guarantee.
    // A version other than the cookie's — app, or a bundle the batch reports — rewrites the device
    // row even mid-day, so an update shows in the version breakdowns at once. An absent bundle
    // header is no news: the row keeps its value, and so does the cookie.
    const cookie = readActivityCookie(req)
    const cookieDay = cookie?.day
    const batchDays = [...days].sort()
    const creditDays = cookieDay === undefined ? batchDays : batchDays.filter((day) => day > cookieDay)
    const engineJs = ctx.engineJsVersion ?? cookie?.engineJs ?? null
    const playerJs = ctx.playerJsVersion ?? cookie?.playerJs ?? null
    const versionChanged =
      cookie?.appVersion !== ctx.appVersion || engineJs !== (cookie?.engineJs ?? null) || playerJs !== (cookie?.playerJs ?? null)
    try {
      await app.analytics.ingest({
        deviceId,
        os: ctx.os,
        osVersion: ctx.osVersion,
        appVersion: ctx.appVersion,
        appVersionName: ctx.appVersionName,
        country: ctx.country,
        engineJsVersion: ctx.engineJsVersion,
        playerJsVersion: ctx.playerJsVersion,
        events: accepted,
        days: creditDays,
        refreshDevice: versionChanged,
      })
    } catch (error) {
      req.log.error({ err: error }, 'pulse ingest failed — client will retry from its queue')
      return reply.code(500).send()
    }
    // The watermark only moves forward, and is only re-sent when it or the version CHANGED — an
    // unchanged value is a wasted Set-Cookie. (Max-Age then refreshes on change, not per request: fine, since
    // an active device moves it daily and the cookie lives two.)
    const lastDay = batchDays.at(-1)!
    const watermark = cookieDay !== undefined && cookieDay > lastDay ? cookieDay : lastDay
    if (watermark !== cookieDay || versionChanged) setActivityCookie(reply, watermark, ctx.appVersion, engineJs, playerJs)
    return reply.code(204).send()
  })
}

/** The wire props are a map of strings; anything else in there is ignored, not an error. */
function stringProps(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const props: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') props[key] = value
  }
  return props
}

/** A bundle revision header: a positive integer, else null (absent or malformed alike). */
function bundleVersion(raw: string | undefined): number | null {
  return raw !== undefined && BUNDLE_VERSION.test(raw) ? Number(raw) : null
}

function readActivityCookie(
  req: FastifyRequest,
): { day: string; appVersion: number; engineJs: number | null; playerJs: number | null } | undefined {
  const raw = req.cookies?.[ACTIVITY_COOKIE]
  if (raw === undefined || req.unsignCookie === undefined) return undefined
  const unsigned = req.unsignCookie(raw)
  const match = unsigned.valid && unsigned.value !== null ? ACTIVITY_VALUE.exec(unsigned.value) : null
  const bundle = (field: string | undefined): number | null => (field && field !== '-' ? Number(field) : null)
  return match
    ? { day: match[1]!, appVersion: Number(match[2]), engineJs: bundle(match[3]), playerJs: bundle(match[4]) }
    : undefined
}

function setActivityCookie(
  reply: FastifyReply,
  day: string,
  appVersion: number,
  engineJs: number | null,
  playerJs: number | null,
): void {
  if (reply.setCookie === undefined) return // cookie plugin off (no secret configured)
  reply.setCookie(ACTIVITY_COOKIE, `${day}.${appVersion}.${engineJs ?? '-'}.${playerJs ?? '-'}`, {
    signed: true,
    httpOnly: true,
    path: '/v1',
    maxAge: ACTIVITY_COOKIE_MAX_AGE_S,
  })
}
