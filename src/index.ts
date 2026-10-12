import { loadConfig } from './config.js'
import { buildServer } from './server.js'
import { closeOnSignal } from './shutdown.js'

const config = loadConfig()
const app = await buildServer({ pg: config.pg, cookieSecret: config.cookieSecret, stats: true, tls: config.tls, sponsorBlockDir: config.sponsorBlockDir })

closeOnSignal(app)

await app.listen({ host: config.host, port: config.port })
