import { Writable } from 'node:stream'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { ProblemRequestLog } from '../src/requestLog.js'

describe('request logging', () => {
  async function logsOf(requests: string[]) {
    const lines: { level: number; msg: string }[] = []
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(JSON.parse(chunk.toString()))
        done()
      },
    })
    const app = Fastify({ logger: { level: 'info', stream }, logController: new ProblemRequestLog(50) })
    app.get('/ok', async () => ({ ok: true }))
    app.get('/bad', async (_req, reply) => reply.code(400).send())
    app.get('/unavailable', async (_req, reply) => reply.code(503).send())
    app.post('/echo', async (req) => req.body)
    app.get('/boom', async () => {
      throw new Error('boom')
    })
    app.get('/slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 80))
      return { ok: true }
    })
    for (const url of requests) {
      if (url === '/echo') await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: '{nope' })
      else await app.inject({ method: 'GET', url })
    }
    await app.close()
    return lines.filter((line) => line.msg !== 'Server listening')
  }

  it('says nothing about fast successes', async () => {
    expect(await logsOf(['/ok'])).toEqual([])
  })

  it('logs a 4xx as a warning, once, with the reason when one was thrown', async () => {
    const lines = await logsOf(['/bad', '/nope', '/echo'])
    expect(lines.map((line) => [line.level, line.msg])).toEqual([
      [40, 'request rejected'],
      [40, 'request rejected'],
      [40, expect.stringMatching(/JSON/)],
    ])
  })

  it('logs a 5xx as an error, once, with the stack when one was thrown', async () => {
    const unavailable = await logsOf(['/unavailable'])
    expect(unavailable.map((line) => [line.level, line.msg])).toEqual([[50, 'request failed']])

    const thrown = await logsOf(['/boom'])
    expect(thrown.map((line) => [line.level, line.msg])).toEqual([[50, 'boom']])
  })

  it('logs a slow response as a warning', async () => {
    const lines = await logsOf(['/slow'])
    expect(lines.map((line) => [line.level, line.msg])).toEqual([[40, 'slow request']])
  })
})
