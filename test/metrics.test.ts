import { createSocket, type Socket } from 'node:dgram'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { statsdTarget } from '../src/metrics.js'
import { buildServer } from '../src/server.js'

describe('request metrics', () => {
  let listener: Socket
  let received: string[]

  beforeEach(async () => {
    received = []
    listener = createSocket('udp4')
    listener.on('message', (message) => received.push(...message.toString().split('\n')))
    await new Promise<void>((resolve) => listener.bind(0, '127.0.0.1', resolve))
  })

  afterEach(() => listener.close())

  it('counts each response by route, method and status class, and times it', async () => {
    const { port } = listener.address() as AddressInfo
    const app = await buildServer({ statsd: { host: '127.0.0.1', port } })
    await app.inject({ method: 'GET', url: '/healthz' })
    await app.inject({ method: 'GET', url: '/v1/link/abc' })
    await app.inject({ method: 'GET', url: '/wp-login.php' })
    await app.close() // flushes the batch
    await expect.poll(() => received.length).toBeGreaterThanOrEqual(9)

    expect(received).toContain('ymusic.api.requests.healthz.get:1|c')
    expect(received).toContain('ymusic.api.requests.v1_link_id.get:1|c')
    expect(received).toContain('ymusic.api.requests.unmatched.get:1|c')
    expect(received.filter((line) => line === 'ymusic.api.status.4xx:1|c').length).toBeGreaterThanOrEqual(1)
    expect(received).toContain('ymusic.api.status.2xx:1|c')
    expect(received.filter((line) => line === 'ymusic.api.errors.404:1|c').length).toBeGreaterThanOrEqual(1)
    expect(received.some((line) => line.startsWith('ymusic.api.errors.2'))).toBe(false)
    expect(received.some((line) => /^ymusic\.api\.response_time\.healthz:\d+\.\d{2}\|ms$/.test(line))).toBe(true)
  })

  it('reads YM_STATSD, defaulting to Netdata on this host', () => {
    expect(statsdTarget(undefined)).toEqual({ host: '127.0.0.1', port: 8125 })
    expect(statsdTarget('192.0.2.10:9125')).toEqual({ host: '192.0.2.10', port: 9125 })
    expect(statsdTarget('off')).toBeUndefined()
    expect(() => statsdTarget('localhost')).toThrow(/YM_STATSD/)
  })
})
