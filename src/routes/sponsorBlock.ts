import type { FastifyInstance } from 'fastify'

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
/** Segments change slowly; only a 200 is cacheable, a 503 must not outlive the first sync. */
const CACHE_CONTROL = 'public, max-age=900'

/**
 *   GET /v1/sponsorblock/segments?v=<videoId> → 200 {segments: [{startTime, endTime, category, videoDuration}]}
 *
 * Seconds, merged and sorted, skippable categories only (src/sponsorBlock/segments.ts). An unknown
 * video is 200 with no segments; 503 until the first build is synced, so the app keeps what it has.
 */
export default async function sponsorBlockRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { v?: string } }>('/v1/sponsorblock/segments', async (req, reply) => {
    const videoId = req.query.v ?? ''
    if (!VIDEO_ID.test(videoId)) return reply.code(400).send()
    const segments = app.sponsorBlock?.segments(videoId)
    if (!segments) return reply.code(503).send()
    return reply.header('cache-control', CACHE_CONTROL).send({ segments })
  })
}
