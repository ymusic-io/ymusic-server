import { createPool } from '../db.js'
import { loadDashboardConfig } from './config.js'
import { buildDashboard } from './server.js'

const config = loadDashboardConfig()
const app = await buildDashboard({
  pool: createPool(config.pg, 4),
  user: config.user,
  password: config.password,
  tls: config.tls,
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void app.close().then(() => process.exit(0)))
}

await app.listen({ host: config.host, port: config.port })
