import type { PgSettings } from './db.js'
import { type TlsFiles, tlsFiles } from './tls.js'

export interface AppConfig {
  host: string
  port: number
  pg?: PgSettings | undefined
  cookieSecret?: string | undefined
  /** Serve HTTPS with this cert (YM_TLS_CERT + YM_TLS_KEY); plain HTTP without. */
  tls?: TlsFiles | undefined
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 8787)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad PORT: ${env.PORT}`)
  return {
    host: env.HOST ?? '0.0.0.0',
    port,
    // The ymusic_server DSN; the cert files are this app server's identity against the DB's
    // private CA (see ymusic-docker-configs/tls). No DSN = pulse ingest off, log-only.
    // No YM_PG_CA = plaintext connection, for a server on the SAME host as the DB (skips the
    // TLS handshake cost) — the DB's pg_hba must have its private-subnet `host` line opened.
    pg: env.YM_PG
      ? {
          dsn: env.YM_PG,
          caFile: env.YM_PG_CA,
          certFile: env.YM_PG_CERT,
          keyFile: env.YM_PG_KEY,
        }
      : undefined,
    cookieSecret: env.YM_COOKIE_SECRET,
    tls: tlsFiles(env.YM_TLS_CERT, env.YM_TLS_KEY, 'YM_TLS'),
  }
}
