import type { FastifyInstance } from 'fastify'

/** How long a QR stays usable. */
export const LINK_TTL_MS = 10 * 60 * 1000

/** A sealed cookie jar is a few KB; anything near this is not one. */
const MAX_PAYLOAD_BYTES = 64 * 1024

const LINK_ID = /^[A-Za-z0-9_-]{22}$/
const PAYLOAD = /^[A-Za-z0-9_-]+$/

/**
 * The QR sign-in relay (see LinkStore):
 *
 *   POST   /v1/link       → 201 {id, expiresInMs}   the desktop opens a slot
 *   PUT    /v1/link/:id   → 204 | 404               the phone fills it, once (base64url text)
 *   GET    /v1/link/:id   → 200 payload | 204 | 404 the desktop polls; 200 consumes it
 *   DELETE /v1/link/:id   → 204                     the desktop gives up
 *
 * 404 means unknown, expired, already filled or already taken — the caller cannot do better with a
 * finer answer, and a prober learns nothing. Without a database every call is a 503.
 */
export default async function linkRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/link', async (_req, reply) => {
    if (!app.links) return reply.code(503).send()
    const id = await app.links.open(LINK_TTL_MS)
    return reply.code(201).send({ id, expiresInMs: LINK_TTL_MS })
  })

  app.put<{ Params: { id: string } }>('/v1/link/:id', { bodyLimit: MAX_PAYLOAD_BYTES }, async (req, reply) => {
    if (!app.links) return reply.code(503).send()
    const payload = typeof req.body === 'string' ? req.body.trim() : ''
    if (!LINK_ID.test(req.params.id) || !PAYLOAD.test(payload)) return reply.code(400).send()
    return reply.code((await app.links.put(req.params.id, payload)) ? 204 : 404).send()
  })

  app.get<{ Params: { id: string } }>('/v1/link/:id', async (req, reply) => {
    if (!app.links) return reply.code(503).send()
    if (!LINK_ID.test(req.params.id)) return reply.code(404).send()
    const read = await app.links.take(req.params.id)
    if (read.state === 'gone') return reply.code(404).send()
    if (read.state === 'pending') return reply.code(204).send()
    return reply.code(200).type('text/plain').header('cache-control', 'no-store').send(read.payload)
  })

  app.delete<{ Params: { id: string } }>('/v1/link/:id', async (req, reply) => {
    if (!app.links) return reply.code(503).send()
    if (LINK_ID.test(req.params.id)) await app.links.close(req.params.id)
    return reply.code(204).send()
  })
}
