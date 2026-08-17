export interface AppConfig {
  host: string
  port: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 8787)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad PORT: ${env.PORT}`)
  return { host: env.HOST ?? '0.0.0.0', port }
}
