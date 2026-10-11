import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import type pg from 'pg'
import { type AppConfig, validateAppConfig } from '../appConfig.js'
import { appendConfig, configHistory, configVersion, latestConfig, StaleBase } from '../configStore.js'
import { httpsOptions, type TlsFiles } from '../tls.js'
import { analytics, BadQuery } from './analytics.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** The Basic Auth user name, set once the credentials check out. */
    user: string
  }
}

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
  app.decorateRequest('user', '')
  app.addHook('onRequest', async (req, reply) => {
    const header = req.headers.authorization
    if (header?.startsWith('Basic ')) {
      const given = sha256(Buffer.from(header.slice(6), 'base64').toString('utf8'))
      if (timingSafeEqual(given, expected)) {
        req.user = options.user
        return
      }
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

  // App config: append-only versions; the newest is live (the API picks it up within a minute).
  const HISTORY_LIMIT = 100
  app.get('/api/config', async () => ({
    live: await latestConfig(options.pool),
    history: await configHistory(options.pool, HISTORY_LIMIT),
  }))

  const versionId = (raw: string) => (/^\d{1,15}$/.test(raw) ? Number(raw) : null)
  app.get<{ Params: { id: string } }>('/api/config/:id', async (req, reply) => {
    const id = versionId(req.params.id)
    const version = id === null ? undefined : await configVersion(options.pool, id)
    return version ?? reply.code(404).send({ error: `no config v${req.params.id}` })
  })

  const append = async (reply: FastifyReply, entry: Parameters<typeof appendConfig>[1]) => {
    try {
      return await appendConfig(options.pool, entry)
    } catch (error) {
      if (error instanceof StaleBase) return reply.code(409).send({ error: error.message })
      throw error
    }
  }

  app.post<{ Body: { config?: unknown; note?: unknown; baseId?: unknown } }>('/api/config', async (req, reply) => {
    const { config, note, baseId } = req.body ?? {}
    const errors = validateAppConfig(config)
    if (typeof baseId !== 'number') errors.push('baseId (the live version the edit started from) is required')
    if (errors.length > 0) return reply.code(400).send({ error: 'invalid config', errors })
    return append(reply, {
      config: config as AppConfig,
      note: typeof note === 'string' && note.trim() ? note.trim() : null,
      author: req.user,
      baseId: baseId as number,
    })
  })

  app.post<{ Params: { id: string }; Body: { note?: unknown; baseId?: unknown } }>(
    '/api/config/:id/revert',
    async (req, reply) => {
      const id = versionId(req.params.id)
      const target = id === null ? undefined : await configVersion(options.pool, id)
      if (!target) return reply.code(404).send({ error: `no config v${req.params.id}` })
      const { note, baseId } = req.body ?? {}
      if (typeof baseId !== 'number') return reply.code(400).send({ error: 'baseId is required' })
      return append(reply, {
        config: target.config,
        note: typeof note === 'string' && note.trim() ? note.trim() : `revert to v${target.id}`,
        author: req.user,
        baseId,
        revertedFrom: target.id,
      })
    },
  )

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
