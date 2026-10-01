import { createRequire } from 'node:module'
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createService } from '../service/src/app.ts'
import type { Clock } from '../service/src/common/clock.ts'
import { JsonLogger } from '../service/src/common/logger.ts'
import { openDatabase, type Db } from '../service/src/db/database.ts'

const require = createRequire(import.meta.url)
const legacy = require('../legacy/app.js') as {
  createApp(db: Db): RequestListener
  migrate(db: Db, opts?: { noSeed?: boolean }): void
}

export const FROZEN = new Date('2016-11-20T10:00:00Z')
export const frozenClock: Clock = { now: () => new Date(FROZEN) }

export function freshDb(): Db {
  return openDatabase(':memory:')
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

export function close(server: Server): Promise<void> {
  return new Promise((r) => {
    server.closeAllConnections()
    server.close(() => r())
  })
}

export function startLegacy(db: Db = freshDb()): Promise<{ url: string; server: Server; db: Db }> {
  const server = createServer(legacy.createApp(db))
  return listen(server).then((url) => ({ url, server, db }))
}

export async function startService(db: Db = freshDb()): Promise<{ url: string; server: Server; db: Db }> {
  const app = await createService({ db, clock: frozenClock, logger: new JsonLogger() })
  const server = createServer(app.getHttpAdapter().getInstance() as RequestListener)
  return { url: await listen(server), server, db }
}
