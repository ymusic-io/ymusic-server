import { loadConfig } from './config.js'
import { buildServer } from './server.js'

const config = loadConfig()
const app = await buildServer({ pg: config.pg, cookieSecret: config.cookieSecret, stats: true })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)))
}

await app.listen({ host: config.host, port: config.port })
