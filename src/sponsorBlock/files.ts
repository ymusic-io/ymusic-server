import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** `<lastUpdated>_<md5>_sqlite.db`, as the mirror names its builds. Sorting by name sorts by age. */
export const DB_FILE = /^\d+_[0-9a-f]{32}_sqlite\.db$/

/** The local builds in [dir], oldest first. */
export function dbFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => DB_FILE.test(name))
    .sort()
    .map((name) => join(dir, name))
}
