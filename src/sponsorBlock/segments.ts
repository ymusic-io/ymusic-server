import { basename } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { FastifyBaseLogger } from 'fastify'
import { dbFiles } from './files.js'

export interface SkipSegment {
  startTime: number
  endTime: number
  category: string
  videoDuration: number
}

/** What the app skips; the rest (selfpromo, preview, filler, …) plays. */
const SKIP_CATEGORIES = new Set(['sponsor', 'music_offtopic', 'intro', 'outro', 'interaction'])
const MIN_SEGMENT_SECONDS = 1
const RESCAN_MS = 10_000

interface OpenDb {
  file: string
  db: DatabaseSync
  query: StatementSync
}

/**
 * Answers from the newest build the sync process (sync.ts) left in [dir], read-only, and moves to a
 * newer one as soon as it lands. Queries are synchronous, so nothing is mid-query on the old build
 * when it is swapped out and closed.
 */
export class SponsorBlockDb {
  private current: OpenDb | null = null
  /** Builds that failed to open, not retried: the next sync replaces them. */
  private readonly broken = new Set<string>()
  private readonly timer: NodeJS.Timeout

  constructor(
    private readonly dir: string,
    private readonly log: FastifyBaseLogger,
  ) {
    this.rescan()
    this.timer = setInterval(() => this.rescan(), RESCAN_MS).unref()
  }

  /** Null until a build is synced. */
  get build(): string | null {
    return this.current ? basename(this.current.file) : null
  }

  /** Null without a build; else the video's skippable spans, merged and sorted. */
  segments(videoId: string): SkipSegment[] | null {
    if (!this.current) return null
    const rows = this.current.query.all(videoId) as unknown as SkipSegment[]
    return mergeSkippable(rows)
  }

  close(): void {
    clearInterval(this.timer)
    this.current?.db.close()
    this.current = null
  }

  private rescan(): void {
    let latest: string | undefined
    try {
      latest = dbFiles(this.dir).at(-1)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log.error({ err: error }, 'sponsorblock: listing builds failed')
      return
    }
    if (!latest || latest === this.current?.file || this.broken.has(latest)) return
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(latest, { readOnly: true })
      const query = db.prepare('SELECT startTime, endTime, category, videoDuration FROM sponsorTimes WHERE videoID = ?')
      const previous = this.current
      this.current = { file: latest, db, query }
      previous?.db.close()
      this.log.info({ build: basename(latest) }, 'sponsorblock: serving build')
    } catch (error) {
      db?.close()
      this.broken.add(latest)
      this.log.error({ err: error, build: basename(latest) }, 'sponsorblock: opening build failed')
    }
  }
}

export function mergeSkippable(rows: SkipSegment[]): SkipSegment[] {
  const skippable = rows
    .map((row) => ({
      startTime: Number(row.startTime),
      endTime: Number(row.endTime),
      category: row.category,
      videoDuration: Number(row.videoDuration) || 0,
    }))
    .filter((seg) => SKIP_CATEGORIES.has(seg.category) && seg.endTime - seg.startTime >= MIN_SEGMENT_SECONDS)
    .sort((a, b) => a.startTime - b.startTime)
  const merged: SkipSegment[] = []
  for (const seg of skippable) {
    const last = merged.at(-1)
    if (last && seg.startTime <= last.endTime) last.endTime = Math.max(last.endTime, seg.endTime)
    else merged.push(seg)
  }
  const first = merged[0]
  if (first && first.startTime < 1) first.startTime = 0
  return merged
}
