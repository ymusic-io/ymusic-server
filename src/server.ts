import Fastify, { type FastifyInstance } from 'fastify'
import { routes } from './routes/index.js'

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Behind nginx/caddy in production; without this every client looks like 127.0.0.1 in the log.
    trustProxy: true,
  })

  for (const route of routes) await app.register(route)

  return app
}
