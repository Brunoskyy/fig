import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import type { NestExpressApplication } from '@nestjs/platform-express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createService } from '../service/src/app.ts'
import { JsonLogger } from '../service/src/common/logger.ts'
import { openDatabase, type Db } from '../service/src/db/database.ts'

async function serve(db: Db, logger = new JsonLogger(() => {})): Promise<{ app: NestExpressApplication; base: string }> {
  const app = await createService({ db, logger })
  await app.listen(0, '127.0.0.1')
  return { app, base: `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}` }
}

describe('service query strings', () => {
  let app: NestExpressApplication
  let base: string
  beforeAll(async () => ({ app, base } = await serve(openDatabase(':memory:'))))
  afterAll(() => app.close())

  // Express 5's default parser would read these as keys like "region[x]"
  // and answer every port; the legacy Express 4 parses them with qs.
  it('parses brackets the way the legacy Express 4 app does', async () => {
    const array = (await (await fetch(`${base}/api/v1/ports?region[]=EU`)).json()) as { count: number }
    expect(array.count).toBe(4)
    const object = (await (await fetch(`${base}/api/v1/ports?region[x]=EU`)).json()) as { count: number }
    expect(object.count).toBe(0)
    const jsonp = await fetch(`${base}/api/v1/ports?callback[]=loadPorts`)
    expect(jsonp.headers.get('content-type')).toMatch(/^application\/javascript/)
    expect(await jsonp.text()).toMatch(/^loadPorts\(/)
  })
})

describe('service errors', () => {
  it('answers an unexpected error with the legacy bare 500 and logs its cause with the request id', async () => {
    const lines: Record<string, unknown>[] = []
    const real = openDatabase(':memory:')
    const failing = new Proxy(real, {
      get: (target, key) =>
        key === 'prepare'
          ? () => {
              throw new Error('disk I/O error')
            }
          : Reflect.get(target, key),
    })
    const { app, base } = await serve(failing, new JsonLogger((l) => lines.push(JSON.parse(l) as Record<string, unknown>)))
    const res = await fetch(`${base}/api/v1/ports`, { headers: { 'x-request-id': 'req-9' } })
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('Internal Server Error')
    await app.close()
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'error',
        msg: 'disk I/O error',
        requestId: 'req-9',
        method: 'GET',
        path: '/api/v1/ports',
        trace: expect.stringContaining('Error: disk I/O error'),
      }),
    )
  })
})

describe('shared database', () => {
  it('waits for the other process to release its lock instead of failing', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'fig-db-')), 'shared.db')
    const db = openDatabase(file)
    // Another connection, standing in for the legacy app, holds the write
    // lock for 300 ms in a separate thread.
    const holder = new Worker(
      `const { DatabaseSync } = require('node:sqlite')
       const { parentPort, workerData } = require('node:worker_threads')
       const other = new DatabaseSync(workerData)
       other.exec('BEGIN IMMEDIATE')
       parentPort.postMessage('locked')
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
       other.exec('COMMIT')
       other.close()`,
      { eval: true, workerData: file },
    )
    await new Promise((r) => holder.once('message', r))
    const started = Date.now()
    expect(() => db.prepare("UPDATE ports SET name = name WHERE code = 'NLRTM'").run()).not.toThrow()
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    await new Promise((r) => holder.once('exit', r))
    db.close()
  })

  it('still gives up when the lock outlasts the timeout', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'fig-db-')), 'shared.db')
    const db = openDatabase(file, { busyTimeoutMs: 50 })
    const holder = new Worker(
      `const { DatabaseSync } = require('node:sqlite')
       const { parentPort, workerData } = require('node:worker_threads')
       const other = new DatabaseSync(workerData)
       other.exec('BEGIN IMMEDIATE')
       parentPort.postMessage('locked')
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)
       other.exec('COMMIT')`,
      { eval: true, workerData: file },
    )
    await new Promise((r) => holder.once('message', r))
    expect(() => db.prepare("UPDATE ports SET name = name WHERE code = 'NLRTM'").run()).toThrow(/locked/)
    await new Promise((r) => holder.once('exit', r))
    db.close()
  })
})
