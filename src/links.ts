import { randomBytes } from 'node:crypto'
import type pg from 'pg'

/** What reading a link finds. */
export type LinkRead = { state: 'ready'; payload: string } | { state: 'pending' } | { state: 'gone' }

/**
 * One-shot relay slots for the QR sign-in: the desktop opens a slot and shows its id in a QR, the
 * phone puts the sealed cookies into it, the desktop takes them out. The payload is encrypted with a
 * key that only ever travels inside the QR, so this store holds ciphertext it cannot read.
 */
export interface LinkStore {
  /** A fresh unguessable id, open for [ttlMs]. */
  open(ttlMs: number): Promise<string>
  /** Fill an open, still-empty slot. False when there is none: unknown, expired or already filled. */
  put(id: string, payload: string): Promise<boolean>
  /** A filled slot is deleted as it is read, so a payload is handed out exactly once. */
  take(id: string): Promise<LinkRead>
  close(id: string): Promise<void>
}

/** 128 random bits, base64url: 22 characters. */
export function newLinkId(): string {
  return randomBytes(16).toString('base64url')
}

export class PgLinkStore implements LinkStore {
  constructor(private readonly pool: pg.Pool) {}

  async open(ttlMs: number): Promise<string> {
    const id = newLinkId()
    // Sweeps expired slots on the way in: opening is rare, so no timer is needed for cleanup.
    await this.pool.query(
      `WITH swept AS (DELETE FROM device_links WHERE expires_at < now())
       INSERT INTO device_links (id, expires_at) VALUES ($1, now() + $2 * interval '1 millisecond')`,
      [id, ttlMs],
    )
    return id
  }

  async put(id: string, payload: string): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE device_links SET payload = $2 WHERE id = $1 AND payload IS NULL AND expires_at > now()',
      [id, payload],
    )
    return result.rowCount === 1
  }

  async take(id: string): Promise<LinkRead> {
    const result = await this.pool.query<{ payload: string | null; taken: boolean }>(
      `WITH taken AS (
         DELETE FROM device_links WHERE id = $1 AND payload IS NOT NULL AND expires_at > now()
         RETURNING payload)
       SELECT payload, true AS taken FROM taken
       UNION ALL
       SELECT NULL, false FROM device_links WHERE id = $1 AND payload IS NULL AND expires_at > now()`,
      [id],
    )
    const row = result.rows[0]
    if (!row) return { state: 'gone' }
    return row.taken && row.payload !== null ? { state: 'ready', payload: row.payload } : { state: 'pending' }
  }

  async close(id: string): Promise<void> {
    await this.pool.query('DELETE FROM device_links WHERE id = $1', [id])
  }
}

/** The same contract in memory, for tests and a dev server without a database. */
export class MemoryLinkStore implements LinkStore {
  private readonly slots = new Map<string, { payload: string | null; expiresAt: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  async open(ttlMs: number): Promise<string> {
    for (const [id, slot] of this.slots) if (slot.expiresAt < this.now()) this.slots.delete(id)
    const id = newLinkId()
    this.slots.set(id, { payload: null, expiresAt: this.now() + ttlMs })
    return id
  }

  async put(id: string, payload: string): Promise<boolean> {
    const slot = this.live(id)
    if (!slot || slot.payload !== null) return false
    slot.payload = payload
    return true
  }

  async take(id: string): Promise<LinkRead> {
    const slot = this.live(id)
    if (!slot) return { state: 'gone' }
    if (slot.payload === null) return { state: 'pending' }
    this.slots.delete(id)
    return { state: 'ready', payload: slot.payload }
  }

  async close(id: string): Promise<void> {
    this.slots.delete(id)
  }

  private live(id: string) {
    const slot = this.slots.get(id)
    return slot && slot.expiresAt > this.now() ? slot : undefined
  }
}
