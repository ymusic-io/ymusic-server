import type { FastifyInstance } from 'fastify'

/**
 * Anonymous usage pulses. The client batches on disk and posts at most every half hour, so this
 * stays cheap: accept the batch, log the counts, answer 204. Context (os, app version, device
 * uuid) rides the common headers, event time rides each event's own `at` — nothing here needs
 * the body beyond its shape.
 */
export default async function pulseRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/pulse', (req, reply) => {
    const body = req.body as { events?: unknown } | null
    const events = Array.isArray(body?.events) ? body.events : []
    const names: Record<string, number> = {}
    for (const event of events) {
      const name = typeof (event as { name?: unknown })?.name === 'string' ? (event as { name: string }).name : '?'
      names[name] = (names[name] ?? 0) + 1
    }
    req.log.info({ count: events.length, names, device: req.headers['x-device-id'] }, 'pulse')
    return reply.code(204).send()
  })
}
