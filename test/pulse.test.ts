import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.js'

let app: Awaited<ReturnType<typeof buildServer>>

beforeEach(async () => {
  app = await buildServer()
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

describe('POST /v1/pulse', () => {
  it('accepts a batch and answers 204 with no body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/pulse',
      headers: { 'x-os': 'windows', 'x-app-ver': '1233', 'x-device-id': 'abc' },
      payload: {
        events: [
          { name: 'app_start', at: 1000, props: { cold: 'true' } },
          { name: 'play', at: 2000 },
        ],
      },
    })

    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
  })

  it('shrugs at an empty or shapeless body rather than erroring', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/pulse', payload: {} })).statusCode).toBe(204)
    expect(
      (await app.inject({ method: 'POST', url: '/v1/pulse', payload: { events: 'not-a-list' } })).statusCode,
    ).toBe(204)
  })

  it('rejects a batch over 15 events whole — the client must chunk', async () => {
    const events = Array.from({ length: 16 }, (_, i) => ({ name: 'app_start', at: 1000 + i }))

    const res = await app.inject({ method: 'POST', url: '/v1/pulse', payload: { events } })

    expect(res.statusCode).toBe(413)
  })

  it('is POST only', async () => {
    expect((await app.inject('/v1/pulse')).statusCode).toBe(404)
  })
})
