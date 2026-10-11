import { createPool } from '../db.js'
import { loadDashboardConfig } from './config.js'
import { closeOnSignal } from '../shutdown.js'
import { buildDashboard } from './server.js'

const config = loadDashboardConfig()
const app = await buildDashboard({
  pool: createPool(config.pg, 4),
  user: config.user,
  password: config.password,
  tls: config.tls,
})

closeOnSignal(app)

await app.listen({ host: config.host, port: config.port })
