import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { EVENTS, type AcceptedEvent } from '../db.js'
import { header } from '../headers.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COUNTRY = /^[a-z]{2}$/i

/** Junk device clocks must not pollute history: anything older than this is dropped. */
const MAX_EVENT_AGE_MS = 60 * 24 * 60 * 60 * 1000

/** The advisory write-skip cookie: the last UTC day this device's activity was credited. */
const ACTIVITY_COOKIE = 'act'
const ACTIVITY_COOKIE_MAX_AGE_S = 2 * 24 * 60 * 60

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
    const now = Date.now()

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
      // The event's own handler turns the wire props into its columns; null = malformed.
      const values = def.values(stringProps((item as { props?: unknown }).props))
      if (values === null) {
        dropped++
        continue
      }
      const clamped = new Date(Math.min(at, now)) // a future clock credits today, not tomorrow
      accepted.push({ name, at: clamped, values })
      days.add(clamped.toISOString().slice(0, 10))
    }

    const deviceId = header(req.headers['x-device-id'])?.toLowerCase()
    const appVersion = Number.parseInt(header(req.headers['x-app-ver']) ?? '', 10) || -1
    const os = (header(req.headers['x-os']) ?? '').toLowerCase()
    const rawCountry = header(req.headers['cf-ipcountry'])
    const country = rawCountry && COUNTRY.test(rawCountry) ? rawCountry.toUpperCase() : null

    req.log.info({ count: raw.length, accepted: accepted.length, dropped, device: deviceId }, 'pulse')
    if (!app.analytics || !deviceId || !UUID.test(deviceId) || accepted.length === 0) {
      return reply.code(204).send()
    }

    // The signed cookie is the server's own past statement of the last credited day; when it
    // covers every day in the batch, the device/activity writes are skipped. Absent, invalid or
    // stale, it falls through to the normal transaction — ON CONFLICT stays the guarantee.
    const cookieDay = readActivityCookie(req)
    const allDays = [...days].sort()
    const covered = cookieDay !== undefined && allDays.every((day) => day === cookieDay)
    try {
      await app.analytics.ingest({
        deviceId,
        os,
        appVersion,
        country,
        events: accepted,
        days: covered ? [] : allDays,
      })
    } catch (error) {
      req.log.error({ err: error }, 'pulse ingest failed — client will retry from its queue')
      return reply.code(500).send()
    }
    setActivityCookie(reply, allDays.at(-1)!)
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

function readActivityCookie(req: FastifyRequest): string | undefined {
  const raw = req.cookies?.[ACTIVITY_COOKIE]
  if (raw === undefined || req.unsignCookie === undefined) return undefined
  const unsigned = req.unsignCookie(raw)
  return unsigned.valid && unsigned.value !== null ? unsigned.value : undefined
}

function setActivityCookie(reply: FastifyReply, day: string): void {
  if (reply.setCookie === undefined) return // cookie plugin off (no secret configured)
  reply.setCookie(ACTIVITY_COOKIE, day, {
    signed: true,
    httpOnly: true,
    path: '/v1',
    maxAge: ACTIVITY_COOKIE_MAX_AGE_S,
  })
}
