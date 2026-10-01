import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createEdge } from '../edge/src/proxy.ts'
import { compile, parseConfig, resolve } from '../edge/src/routes.ts'
import { close, listen } from './helpers.ts'

/** A fake upstream that echoes what it received, so tests can see exactly what the edge forwarded. */
function echo(name: string, overrides: Record<string, (res: import('node:http').ServerResponse) => void> = {}): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const special = overrides[req.url ?? '']
      if (special) return special(res)
      const body = JSON.stringify({ from: name, method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
      res.writeHead(200, { 'content-type': 'application/json', connection: 'keep-alive', 'keep-alive': 'timeout=99', 'x-upstream': name })
      res.end(body)
    })
  })
}

const yaml = (legacy: string, service: string, routes: string, extra = '') => `
upstreams: { legacy: "${legacy}", service: "${service}" }
timeoutMs: 300
maxBodyBytes: 1000
${extra}
routes:
${routes}
`

describe('routes.yaml', () => {
  it('matches parameters and falls back from HEAD to GET', () => {
    const routes = compile(parseConfig(yaml('http://a.test', 'http://b.test', '  - { match: "GET /api/v1/bookings/:id", to: shadow }')).routes)
    expect(resolve(routes, 'GET', '/api/v1/bookings/12')?.to).toBe('shadow')
    expect(resolve(routes, 'HEAD', '/api/v1/bookings/12')?.to).toBe('shadow')
    expect(resolve(routes, 'GET', '/api/v1/bookings/12/cancel')).toBeNull()
    expect(resolve(routes, 'POST', '/api/v1/bookings/12')).toBeNull()
  })

  it('refuses shadow mode on a route that writes', () => {
    expect(() => parseConfig(yaml('http://a.test', 'http://b.test', '  - { match: "POST /api/v1/quote", to: shadow }'))).toThrow(/would write twice/)
  })

  it('refuses an unknown target', () => {
    expect(() => parseConfig(yaml('http://a.test', 'http://b.test', '  - { match: "GET /x", to: new }'))).toThrow()
  })
})

describe('edge', () => {
  let legacy: Server
  let service: Server
  let edge: Server
  let base: string
  let shadowDir: string

  beforeAll(async () => {
    legacy = echo('legacy')
    service = echo('service', {
      '/api/v1/bookings/7': (res) => {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":{"code":"NOT_FOUND"}}')
      },
      '/slow': () => {
        /* never answers */
      },
    })
    const l = await listen(legacy)
    const s = await listen(service)
    shadowDir = mkdtempSync(join(tmpdir(), 'fig-shadow-'))
    const config = parseConfig(
      yaml(
        l,
        s,
        [
          '  - { match: "GET /api/v1/ports", to: service }',
          '  - { match: "POST /api/v1/quote", to: service }',
          '  - { match: "GET /api/v1/bookings/:id", to: shadow, ignore: ["$.from", "$.headers"] }',
          '  - { match: "GET /slow", to: service }',
          '  - { match: "GET /gone", to: service }',
        ].join('\n'),
      ),
    )
    config.upstreams.service = s
    edge = createEdge({ config, shadowDir, log: () => {} })
    base = await listen(edge)
  })

  afterAll(async () => {
    await Promise.all([close(edge), close(legacy), close(service)])
  })

  it('sends unlisted routes to the default and listed ones to their target', async () => {
    const a = await fetch(`${base}/api/v1/customers/1/bookings`)
    expect(a.headers.get('x-upstream')).toBe('legacy')
    expect(a.headers.get('x-fig-route')).toBe('legacy')
    const b = await fetch(`${base}/api/v1/ports?region=eu`)
    expect(b.headers.get('x-upstream')).toBe('service')
    expect(((await b.json()) as { url: string }).url).toBe('/api/v1/ports?region=eu')
  })

  it('forwards method, body and end-to-end headers, and drops hop-by-hop ones', async () => {
    // fetch() refuses to send Connection, so this one goes through node:http.
    const { status, headers, body } = await new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((ok, ko) => {
      const req = httpRequest(`${base}/api/v1/quote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-1', 'x-custom': 'yes', 'x-kept': 'yes', connection: 'x-custom' },
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }))
      })
      req.on('error', ko)
      req.end('{"from":"NLRTM"}')
    })
    expect(status).toBe(200)
    const seen = JSON.parse(body) as { method: string; body: string; headers: Record<string, string> }
    expect(seen.method).toBe('POST')
    expect(seen.body).toBe('{"from":"NLRTM"}')
    expect(seen.headers['content-length']).toBe('16')
    expect(seen.headers['x-request-id']).toBe('req-1')
    expect(seen.headers['x-kept']).toBe('yes')
    // Listed in Connection, so it belongs to the hop and must not travel on.
    expect(seen.headers['x-custom']).toBeUndefined()
    expect(headers['keep-alive']).not.toBe('timeout=99')
  })

  it('gives every request an id', async () => {
    const res = await fetch(`${base}/api/v1/ports`)
    const seen = (await res.json()) as { headers: Record<string, string> }
    expect(seen.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('answers shadowed routes from legacy and logs the difference', async () => {
    const res = await fetch(`${base}/api/v1/bookings/7`, { headers: { 'x-request-id': 'shadow-1' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-upstream')).toBe('legacy')
    expect(res.headers.get('x-fig-route')).toBe('shadow')
    await new Promise((r) => setTimeout(r, 50))
    const [file] = readdirSync(shadowDir)
    const record = JSON.parse(readFileSync(join(shadowDir, file!), 'utf8').trim()) as { requestId: string; differences: { path: string }[] }
    expect(record.requestId).toBe('shadow-1')
    expect(record.differences.map((d) => d.path)).toContain('status')
    // Ignored paths stay out of the log.
    expect(record.differences.map((d) => d.path)).not.toContain('$.from')
  })

  it('answers 504 when the upstream is too slow', async () => {
    const res = await fetch(`${base}/slow`)
    expect(res.status).toBe(504)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UPSTREAM_TIMEOUT')
  })

  it('answers 413 for bodies over the limit without contacting the upstream', async () => {
    const res = await fetch(`${base}/api/v1/quote`, { method: 'POST', body: 'x'.repeat(2000) })
    expect(res.status).toBe(413)
  })

  it('answers 502 when the upstream is down', async () => {
    const dead = createServer()
    const url = await listen(dead)
    await close(dead)
    const config = parseConfig(yaml(url, url, '  - { match: "GET /gone", to: service }'))
    const lonely = createEdge({ config, shadowDir, log: () => {} })
    const at = await listen(lonely)
    const res = await fetch(`${at}/gone`)
    expect(res.status).toBe(502)
    await close(lonely)
  })
})
