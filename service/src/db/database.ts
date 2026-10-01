import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

const { DatabaseSync: Sqlite } = process.getBuiltinModule('node:sqlite')

/** Injection token for the shared database. */
export const DB = Symbol('DB')

export type Db = DatabaseSync

/**
 * During the migration both systems read and write the same database: the
 * strangler routes traffic, not data. The schema is the legacy one, applied
 * from legacy/db so there is exactly one definition of it.
 */
export function openDatabase(file: string, options: { seed?: boolean } = {}): Db {
  const db = new Sqlite(file)
  const dir = join(import.meta.dirname, '..', '..', '..', 'legacy', 'db')
  db.exec(readFileSync(join(dir, 'schema.sql'), 'utf8'))
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM ports').get() as { n: number }
  if (n === 0 && options.seed !== false) db.exec(readFileSync(join(dir, 'seed.sql'), 'utf8'))
  return db
}
