import { createSocket, type Socket } from 'node:dgram'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/** One UDP datagram stays under a typical MTU; Netdata splits the lines on \n. */
const MAX_PACKET_BYTES = 1400
const FLUSH_INTERVAL_MS = 1000
const PREFIX = 'ymusic.api'

export interface StatsdTarget {
  host: string
  port: number
}

/** `host:port`, or `off` for none. Unset = Netdata's StatsD on this host (127.0.0.1:8125). */
export function statsdTarget(value: string | undefined): StatsdTarget | undefined {
  if (value === 'off') return undefined
  const [host = '', portText = ''] = (value ?? '127.0.0.1:8125').split(':')
  const port = Number(portText)
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`bad YM_STATSD: ${value}`)
  return { host, port }
}

/**
 * Fire-and-forget StatsD over UDP. Lines are batched and flushed once a second (or when a packet
 * is full), so a request costs a string append, not a syscall. Nothing listening = packets
 * dropped; metrics never fail a request.
 */
export class Statsd {
  private readonly socket: Socket
  private buffer = ''
  private readonly timer: NodeJS.Timeout

  constructor(private readonly target: StatsdTarget) {
    this.socket = createSocket('udp4')
    this.socket.on('error', () => {})
    this.socket.unref()
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS)
    this.timer.unref()
  }

  count(name: string): void {
    this.push(`${PREFIX}.${name}:1|c`)
  }

  timing(name: string, ms: number): void {
    this.push(`${PREFIX}.${name}:${ms.toFixed(2)}|ms`)
  }

  private push(line: string): void {
    if (this.buffer.length + line.length + 1 > MAX_PACKET_BYTES) this.flush()
    this.buffer = this.buffer ? `${this.buffer}\n${line}` : line
  }

  flush(done: () => void = () => {}): void {
    if (!this.buffer) return done()
    this.socket.send(this.buffer, this.target.port, this.target.host, () => done())
    this.buffer = ''
  }

  /** Sends what is left, then closes: a socket closed before its send completes drops it. */
  close(): Promise<void> {
    clearInterval(this.timer)
    return new Promise((resolve) => this.flush(() => this.socket.close(() => resolve())))
  }
}

/** `/v1/link/:id` → `v1_link_id`; requests no route matched share `unmatched`. */
export function routeKey(request: FastifyRequest): string {
  const url = request.routeOptions.url
  if (!url) return 'unmatched'
  return url.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root'
}

/**
 * Per response: `requests.<route>.<method>` and `status.<2xx…5xx>` counters, an
 * `errors.<code>` counter for a 4xx/5xx (which error, not just its class), and a
 * `response_time.<route>` timer (Netdata derives percentiles), summed across the cluster workers.
 */
export function registerMetrics(app: FastifyInstance, statsd: Statsd): void {
  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const route = routeKey(request)
    statsd.count(`requests.${route}.${request.method.toLowerCase()}`)
    statsd.count(`status.${Math.floor(reply.statusCode / 100)}xx`)
    if (reply.statusCode >= 400) statsd.count(`errors.${reply.statusCode}`)
    statsd.timing(`response_time.${route}`, reply.elapsedTime)
  })
  app.addHook('onClose', async () => statsd.close())
}
