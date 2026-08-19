import fastifyCookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import { Analytics, type PgSettings } from './db.js'
import { routes } from './routes/index.js'

declare module 'fastify' {
  interface FastifyInstance {
    /** Null without a configured database: pulse stays log-only, everything else unaffected. */
    analytics: Analytics | null
  }
}

export interface ServerOptions {
  /** Postgres for the pulse ingest (YM_PG + cert files). Absent in tests and plain dev. */
  pg?: PgSettings | undefined
  /** HMAC secret for signed cookies (YM_COOKIE_SECRET). Absent = no cookies, ever. */
  cookieSecret?: string | undefined
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Behind nginx/caddy in production; without this every client looks like 127.0.0.1 in the log.
    trustProxy: true,
  })

  if (options.cookieSecret) await app.register(fastifyCookie, { secret: options.cookieSecret })

  app.decorate('analytics', options.pg ? await Analytics.open(options.pg) : null)
  app.addHook('onClose', async () => {
    await app.analytics?.close()
  })

  for (const route of routes) await app.register(route)

  return app
}
