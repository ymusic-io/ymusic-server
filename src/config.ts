import type { PgSettings } from './db.js'

export interface AppConfig {
  host: string
  port: number
  pg?: PgSettings | undefined
  cookieSecret?: string | undefined
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 8787)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad PORT: ${env.PORT}`)
  return {
    host: env.HOST ?? '0.0.0.0',
    port,
    // The ymusic_server DSN; the cert files are this app server's identity against the DB's
    // private CA (see ymusic-docker-configs/tls). No DSN = pulse ingest off, log-only.
    pg: env.YM_PG
      ? {
          dsn: env.YM_PG,
          caFile: env.YM_PG_CA,
          certFile: env.YM_PG_CERT,
          keyFile: env.YM_PG_KEY,
        }
      : undefined,
    cookieSecret: env.YM_COOKIE_SECRET,
  }
}
