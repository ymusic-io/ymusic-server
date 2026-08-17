import type { FastifyInstance } from 'fastify'

/** Liveness for the proxy and whatever watches the box. Deliberately cheap: no disk, no network. */
export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', () => ({ ok: true, uptimeSeconds: Math.round(process.uptime()) }))
}
