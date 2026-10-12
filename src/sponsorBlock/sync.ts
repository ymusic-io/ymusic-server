import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { DatabaseSync } from 'node:sqlite'
import { DB_FILE, dbFiles } from './files.js'

/**
 * Keeps [dir] holding the newest SponsorBlock build of the sb-mirror server (sponsor-block-mirror:
 * it turns SponsorBlock's sponsorTimes.csv into an indexed sqlite every few minutes). One process,
 * never one per API worker: each build is ~1.5 GB.
 *
 *   YM_SB_MIRROR   the mirror, default https://sb-mirror.ymusicapp.com
 *   YM_SB_DIR      where builds land, default data/sponsorblock (the API reads the same dir)
 */
const MIRROR = (process.env.YM_SB_MIRROR ?? 'https://sb-mirror.ymusicapp.com').replace(/\/+$/, '')
const DIR = process.env.YM_SB_DIR ?? 'data/sponsorblock'
const POLL_MS = 60_000
/** The API swaps to a new build within seconds; one older stays for a worker that has not yet. */
const KEEP = 2
const TMP = join(DIR, '.download.tmp')

function log(msg: string, extra?: unknown): void {
  console.log(extra === undefined ? msg : `${msg} ${extra instanceof Error ? extra.stack : JSON.stringify(extra)}`)
}

async function newestOnMirror(): Promise<string> {
  const res = await fetch(`${MIRROR}/db_list`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`db_list HTTP ${res.status}`)
  const body = (await res.json()) as { db?: unknown }
  const names = Array.isArray(body.db) ? body.db.filter((n): n is string => typeof n === 'string' && DB_FILE.test(n)) : []
  const newest = names.sort().at(-1)
  if (!newest) throw new Error(`db_list has no build: ${JSON.stringify(body)}`)
  return newest
}

/** Streams the build to TMP, md5-checked against the hash in its name and opened once as sqlite. */
async function download(name: string): Promise<void> {
  const res = await fetch(`${MIRROR}/mirror/${name}`)
  if (!res.ok || !res.body) throw new Error(`download ${name}: HTTP ${res.status}`)
  const md5 = createHash('md5')
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      md5.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(res.body), hashing, createWriteStream(TMP))
  const digest = md5.digest('hex')
  if (!name.includes(`_${digest}_`)) throw new Error(`download ${name}: md5 ${digest} mismatch`)
  const db = new DatabaseSync(TMP, { readOnly: true })
  try {
    db.prepare('SELECT videoID FROM sponsorTimes LIMIT 1').get()
  } finally {
    db.close()
  }
}

async function tick(): Promise<void> {
  const newest = await newestOnMirror()
  if (existsSync(join(DIR, newest))) return
  log(`downloading ${newest}`)
  const startedAt = Date.now()
  try {
    await download(newest)
  } catch (error) {
    rmSync(TMP, { force: true })
    throw error
  }
  renameSync(TMP, join(DIR, newest))
  log(`synced ${newest} in ${Math.round((Date.now() - startedAt) / 1000)} s`)
  const files = dbFiles(DIR)
  for (const old of files.slice(0, Math.max(0, files.length - KEEP))) {
    rmSync(old, { force: true })
    log(`deleted ${old}`)
  }
}

mkdirSync(DIR, { recursive: true })
rmSync(TMP, { force: true })
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true
    rmSync(TMP, { force: true })
    process.exit(0)
  })
}
log(`sponsorblock sync: ${MIRROR} → ${DIR}`)
while (!stopping) {
  try {
    await tick()
  } catch (error) {
    log('sync failed', error)
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS))
}
