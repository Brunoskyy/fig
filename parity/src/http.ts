import { createRequire } from 'node:module'
import { createServer, request, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createService } from '../../service/src/app.ts'
import { JsonLogger } from '../../service/src/common/logger.ts'
import { openDatabase, type Db } from '../../service/src/db/database.ts'
import type { Captured } from './diff.ts'
import type { CorpusCase, RouteCorpus } from './corpus.ts'

/** Recording and replay both run with this clock, so dates and expiries line up. */
export const PARITY_NOW = '2016-11-20T10:00:00Z'

const require = createRequire(import.meta.url)

/** Headers that are part of the contract. Everything else (date, etag, request ids) is volatile by nature. */
export const CONTRACT_HEADERS = ['content-type']

export function freshDatabase(corpus: RouteCorpus): Db {
  const db = openDatabase(':memory:')
  if (corpus.setup) db.exec(corpus.setup)
  return db
}

async function listen(handler: RequestListener): Promise<{ url: string; server: Server }> {
  const server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}

export type Side = 'legacy' | 'service'

/**
 * Starts one side in process on a fresh, seeded database. Each side gets its
 * own copy so autoincrement ids come out the same and no case leaks into
 * the other side's state.
 */
export async function start(side: Side, corpus: RouteCorpus): Promise<{ url: string; stop(): Promise<void> }> {
  process.env.QUAYSIDE_NOW = PARITY_NOW
  process.env.QUAYSIDE_QUIET = '1'
  const db = freshDatabase(corpus)
  let handler: RequestListener
  if (side === 'legacy') {
    const legacy = require('../../legacy/app.js') as { createApp(db: Db): RequestListener }
    handler = legacy.createApp(db)
  } else {
    const app = await createService({ db, clock: { now: () => new Date(PARITY_NOW) }, logger: new JsonLogger() })
    handler = app.getHttpAdapter().getInstance() as RequestListener
  }
  const { url, server } = await listen(handler)
  return {
    url,
    stop: () =>
      new Promise((r) => {
        server.closeAllConnections()
        server.close(() => {
          db.close()
          r()
        })
      }),
  }
}

export function requestFor(corpus: RouteCorpus, c: CorpusCase): { method: string; path: string; headers: Record<string, string>; body?: string } {
  const path = c.path ?? corpus.match.split(' ')[1]!
  if (/\/:/.test(path)) throw new Error(`${corpus.route} / ${c.name}: path still has a parameter, give the case a path`)
  const body = c.raw ?? (c.body === undefined ? undefined : JSON.stringify(c.body))
  const headers = { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(c.headers ?? {}) }
  return { method: corpus.method, path, headers, ...(body !== undefined ? { body } : {}) }
}

export function send(base: string, req: ReturnType<typeof requestFor>, timeoutMs = 5000): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const out = request(new URL(req.path, base), { method: req.method, headers: req.headers, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const headers: Record<string, string> = {}
        for (const h of CONTRACT_HEADERS) {
          const v = res.headers[h]
          if (v !== undefined) headers[h] = Array.isArray(v) ? v.join(', ') : v
        }
        resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    out.on('timeout', () => out.destroy(new Error(`${req.method} ${req.path} timed out`)))
    out.on('error', reject)
    out.end(req.body)
  })
}
