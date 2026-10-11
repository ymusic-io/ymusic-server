import type { PgSettings } from '../db.js'
import { type TlsFiles, tlsFiles } from '../tls.js'

export interface DashboardConfig {
  host: string
  port: number
  pg: PgSettings
  user: string
  password: string
  tls?: TlsFiles | undefined
}

export function loadDashboardConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const port = Number(env.DASHBOARD_PORT ?? 8790)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad DASHBOARD_PORT: ${env.DASHBOARD_PORT}`)
  const required = (name: string) => {
    const value = env[name]
    if (!value) throw new Error(`${name} is not set`)
    return value
  }
  return {
    // Loopback unless told otherwise: the dashboard is private.
    host: env.DASHBOARD_HOST ?? '127.0.0.1',
    port,
    // The ymusic_readonly DSN; the DB cert files are shared with the API server's.
    pg: { dsn: required('DASHBOARD_PG'), caFile: env.YM_PG_CA, certFile: env.YM_PG_CERT, keyFile: env.YM_PG_KEY },
    user: required('DASHBOARD_USER'),
    password: required('DASHBOARD_PASSWORD'),
    tls: tlsFiles(env.DASHBOARD_TLS_CERT, env.DASHBOARD_TLS_KEY, 'DASHBOARD_TLS'),
  }
}
