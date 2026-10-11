import type { FastifyInstance } from 'fastify'

/** Under pm2's --kill-timeout (15 s), so the process exits on its own terms. */
const SHUTDOWN_TIMEOUT_MS = 10_000

/**
 * SIGINT/SIGTERM close the server gracefully: in-flight requests finish, then the pool ends. A
 * close that hangs (a request stuck on the database, a long rollup) is cut off at the deadline,
 * and a second signal (Ctrl+C again) exits at once. Interrupted rollups roll back.
 */
export function closeOnSignal(app: FastifyInstance): void {
  let closing = false
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (closing) {
        app.log.warn({ signal }, 'second signal — exiting now')
        process.exit(1)
      }
      closing = true
      app.log.info({ signal }, 'shutting down')
      setTimeout(() => {
        app.log.error(`shutdown took over ${SHUTDOWN_TIMEOUT_MS} ms — exiting`)
        process.exit(1)
      }, SHUTDOWN_TIMEOUT_MS).unref()
      app.close().then(
        () => process.exit(0),
        (error: unknown) => {
          app.log.error({ err: error }, 'shutdown failed')
          process.exit(1)
        },
      )
    })
  }
}
