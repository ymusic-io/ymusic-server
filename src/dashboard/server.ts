import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import Fastify, { type FastifyInstance } from 'fastify'
import type pg from 'pg'
import { httpsOptions, type TlsFiles } from '../tls.js'
import { analytics, BadQuery } from './analytics.js'

export interface DashboardOptions {
  pool: pg.Pool
  user: string
  password: string
  tls?: TlsFiles | undefined
}

/** The frontend, served as-is from the repo's dashboard/ (same relative path from src/ and dist/). */
const PUBLIC = new URL('../../dashboard/', import.meta.url)
const FILES: Record<string, string> = {
  '/': 'index.html',
  '/analytics': 'index.html',
  '/config': 'index.html',
  '/app.js': 'app.js',
}
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8' }

const sha256 = (text: string) => createHash('sha256').update(text).digest()

export async function buildDashboard(options: DashboardOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
    ...httpsOptions(options.tls),
  })

  // Basic auth on every route. Hashing both sides first gives timingSafeEqual equal lengths.
  const expected = sha256(`${options.user}:${options.password}`)
  app.addHook('onRequest', async (req, reply) => {
    const header = req.headers.authorization
    if (header?.startsWith('Basic ')) {
      const given = sha256(Buffer.from(header.slice(6), 'base64').toString('utf8'))
      if (timingSafeEqual(given, expected)) return
    }
    return reply.code(401).header('www-authenticate', 'Basic realm="YMusic dashboard", charset="UTF-8"').send()
  })

  app.get('/api/analytics', async (req, reply) => {
    const query = req.query as Record<string, unknown>
    const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
    try {
      return await analytics(options.pool, { from: text(query.from), to: text(query.to), os: text(query.os) })
    } catch (error) {
      if (error instanceof BadQuery) return reply.code(400).send({ error: error.message })
      throw error
    }
  })

  for (const [path, file] of Object.entries(FILES)) {
    app.get(path, async (_req, reply) => {
      // Read per request: an edited frontend shows on reload.
      const body = await readFile(new URL(file, PUBLIC), 'utf8')
      return reply.type(TYPES[file.split('.').pop()!]!).header('cache-control', 'no-store').send(body)
    })
  }

  app.addHook('onClose', async () => {
    await options.pool.end()
  })
  return app
}
