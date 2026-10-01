#!/usr/bin/env node
// Starts legacy, service and edge as real processes on one shared database,
// sends a little traffic through the edge, prints what came back and what
// shadow mode logged, then stops everything. Takes about five seconds.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const data = mkdtempSync(join(tmpdir(), 'fig-demo-'))
const env = { ...process.env, QUAYSIDE_DB: join(data, 'quayside.db'), QUAYSIDE_NOW: '2016-11-20T10:00:00Z', QUAYSIDE_QUIET: '1' }
const tsx = join(root, 'node_modules', '.bin', 'tsx')
const children = []
const start = (cmd, args, extra = {}) => {
  const child = spawn(cmd, args, { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'ignore', 'inherit'] })
  children.push(child)
}
const stop = () => children.forEach((c) => c.kill())
const deadline = setTimeout(() => {
  console.error('demo timed out')
  stop()
  process.exit(1)
}, 30_000)

async function up(url) {
  for (let i = 0; i < 100; i += 1) {
    try {
      await fetch(url)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error(`${url} did not come up`)
}

const shadowDir = join(root, 'migration', 'shadow')
const before = new Map(existsSync(shadowDir) ? readdirSync(shadowDir).map((f) => [f, readFileSync(join(shadowDir, f), 'utf8').length]) : [])

try {
  start(process.execPath, ['legacy/server.js'], { PORT: '4100' })
  await up('http://127.0.0.1:4100/ping')
  // Legacy created and seeded the database; the service opens the same file.
  start(tsx, ['service/src/main.ts'], { SERVICE_PORT: '4200' })
  start(tsx, ['edge/src/main.ts'], { EDGE_PORT: '4000' })
  await up('http://127.0.0.1:4200/api/v1/ports')
  await up('http://127.0.0.1:4000/ping')

  const edge = 'http://127.0.0.1:4000'
  const call = async (method, path, body) => {
    const res = await fetch(edge + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) })
    const text = await res.text()
    console.log(`${method.padEnd(4)} ${path.padEnd(34)} ${res.status}  ${(res.headers.get('x-fig-route') ?? '').padEnd(7)} ${text.slice(0, 70)}`)
    return text.startsWith('{') ? JSON.parse(text) : text
  }
  const quote = await call('POST', '/api/v1/quote', { from: 'NLRTM', to: 'USNYC', container: '40HC', depart: '2016-12-03', customer: 2 })
  await call('POST', '/api/v1/bookings', { quote: quote.quote.id })
  await call('GET', '/api/v1/ports?region=SA')
  await call('GET', '/api/v1/bookings/1')
  await call('GET', '/api/v1/bookings/999')
  await call('GET', '/ping')
  await new Promise((r) => setTimeout(r, 200))

  console.log('\nshadow log, new lines:')
  for (const f of existsSync(shadowDir) ? readdirSync(shadowDir) : []) {
    const text = readFileSync(join(shadowDir, f), 'utf8').slice(before.get(f) ?? 0)
    for (const line of text.trim().split('\n').filter(Boolean)) {
      const r = JSON.parse(line)
      console.log(`  ${r.route} ${r.url}: ${r.differences.map((d) => `${d.path} ${JSON.stringify(d.legacy)} -> ${JSON.stringify(d.service)}`).join('; ')}`)
    }
  }
} finally {
  clearTimeout(deadline)
  stop()
  rmSync(data, { recursive: true, force: true })
}
