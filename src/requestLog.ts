import { type FastifyReply, type FastifyRequest, LogController } from 'fastify'

/**
 * Fastify's per-request logging, cut down to what needs a human: a 5xx (error), a 4xx (warn) and a
 * response slower than [slowMs] (warn). Every other request is only counted, in Netdata
 * (metrics.ts).
 */
export class ProblemRequestLog extends LogController {
  /** Requests whose thrown error is already logged, so requestCompleted does not repeat them. */
  private readonly logged = new WeakSet<FastifyRequest>()

  constructor(private readonly slowMs: number) {
    super()
  }

  override incomingRequest(): void {}

  override requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply): void {
    if (this.logged.has(request)) return
    const responseTime = reply.elapsedTime
    const line = { req: request, res: reply, responseTime }
    if (error || reply.statusCode >= 500) reply.log.error({ ...line, err: error ?? undefined }, 'request failed')
    else if (reply.statusCode >= 400) reply.log.warn(line, 'request rejected')
    else if (responseTime >= this.slowMs) reply.log.warn(line, 'slow request')
  }

  /** A thrown error: one line with the request and the error (its stack, its reason for a 4xx). */
  override defaultErrorLog(error: Error, request: FastifyRequest, reply: FastifyReply): void {
    this.logged.add(request)
    const line = { req: request, res: reply, err: error }
    if (reply.statusCode >= 500) reply.log.error(line, error?.message)
    else reply.log.warn(line, error?.message)
  }

  /** requestCompleted logs the 404 with the method and URL; this would only repeat it. */
  override routeNotFound(): void {}
}
