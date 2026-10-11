import fastifyCookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import { Analytics, openPool, type PgSettings } from './db.js'
import { type LinkStore, PgLinkStore } from './links.js'
import { routes } from './routes/index.js'
import { scheduleRollup } from './stats.js'
import { httpsOptions, type TlsFiles } from './tls.js'

declare module 'fastify' {
  interface FastifyInstance {
    /** Null without a configured database: pulse stays log-only, everything else unaffected. */
    analytics: Analytics | null
    /** The QR sign-in relay; null without a database. */
    links: LinkStore | null
  }
}

export interface ServerOptions {
  /** Postgres for the pulse ingest (YM_PG + cert files). Absent in tests and plain dev. */
  pg?: PgSettings | undefined
  /** HMAC secret for signed cookies (YM_COOKIE_SECRET). Absent = no cookies, ever. */
  cookieSecret?: string | undefined
  /** Overrides the database-backed relay — tests pass a MemoryLinkStore. */
  links?: LinkStore | undefined
  /** Run the nightly dashboard rollups (stats.ts) against [pg]. Off in tests. */
  stats?: boolean | undefined
  /** Serve HTTPS with this cert. */
  tls?: TlsFiles | undefined
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Behind nginx/caddy in production; without this every client looks like 127.0.0.1 in the log.
    trustProxy: true,
    ...httpsOptions(options.tls),
  })

  if (options.cookieSecret) await app.register(fastifyCookie, { secret: options.cookieSecret })

  const pool = options.pg ? await openPool(options.pg) : null
  app.decorate('analytics', pool ? new Analytics(pool) : null)
  app.decorate('links', options.links ?? (pool ? new PgLinkStore(pool) : null))
  const stopStats = pool && options.stats ? scheduleRollup(pool, app.log) : null
  app.addHook('onClose', async () => {
    stopStats?.()
    await pool?.end()
  })

  for (const route of routes) await app.register(route)

  return app
}
