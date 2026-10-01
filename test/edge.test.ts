import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createEdge, upstreamUrl } from '../edge/src/proxy.ts'
import { compile, parseConfig, resolve } from '../edge/src/routes.ts'
import { close, listen } from './helpers.ts'

/** A fake upstream that echoes what it received, so tests can see exactly what the edge forwarded. */
function echo(name: string, overrides: Record<string, (res: ServerResponse) => void> = {}): Server {
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

  it('refuses the same route listed twice, even with different parameter names', () => {
    const twice = ['  - { match: "GET /api/v1/bookings/:id", to: shadow }', '  - { match: "GET /api/v1/bookings/:code", to: service }'].join('\n')
    expect(() => parseConfig(yaml('http://a.test', 'http://b.test', twice))).toThrow(/list each route once/)
    const same = ['  - { match: "GET /api/v1/ports", to: service }', '  - { match: "GET /api/v1/ports/", to: legacy }'].join('\n')
    expect(() => parseConfig(yaml('http://a.test', 'http://b.test', same))).toThrow(/list each route once/)
    const different = ['  - { match: "GET /api/v1/ports", to: service }', '  - { match: "HEAD /api/v1/ports", to: legacy }'].join('\n')
    expect(() => parseConfig(yaml('http://a.test', 'http://b.test', different))).not.toThrow()
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
    const { status, headers, body } = await new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((ok, ko) => {
      const req = httpRequest(
        `${base}/api/v1/quote`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-request-id': 'req-1', 'x-custom': 'yes', 'x-kept': 'yes', connection: 'x-custom' },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }))
        },
      )
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

describe('edge in shadow mode', () => {
  it('answers from legacy without waiting for a slow service', async () => {
    const legacy = createServer((_, res) => res.end('{"ok":true}'))
    const service = createServer(() => {
      /* never answers */
    })
    const l = await listen(legacy)
    const s = await listen(service)
    const config = parseConfig(yaml(l, s, '  - { match: "GET /x", to: shadow }').replace('timeoutMs: 300', 'timeoutMs: 2000'))
    const edge = createEdge({ config, shadowDir: mkdtempSync(join(tmpdir(), 'fig-shadow-')), log: () => {} })
    const base = await listen(edge)
    const started = Date.now()
    const res = await fetch(`${base}/x`)
    expect(res.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(1000)
    await Promise.all([close(edge), close(legacy), close(service)])
  })

  it('appends to X-Forwarded-For and keeps HEAD lengths', async () => {
    const upstream = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '12', 'x-xff': String(req.headers['x-forwarded-for']) })
      res.end(req.method === 'HEAD' ? undefined : '{"a":"1234"}')
    })
    const u = await listen(upstream)
    const edge = createEdge({
      config: parseConfig(yaml(u, u, '  - { match: "GET /h", to: service }')),
      shadowDir: mkdtempSync(join(tmpdir(), 'fig-shadow-')),
      log: () => {},
    })
    const base = await listen(edge)
    const get = await fetch(`${base}/h`, { headers: { 'x-forwarded-for': '203.0.113.9' } })
    expect(get.headers.get('x-xff')).toBe('203.0.113.9, 127.0.0.1')
    const head = await fetch(`${base}/h`, { method: 'HEAD' })
    expect(head.headers.get('content-length')).toBe('12')
    await Promise.all([close(edge), close(upstream)])
  })
})

/** Sends raw bytes and returns what came back, for requests fetch() will not make. */
function raw(base: string, text: string, options: { end?: boolean } = {}): Promise<string> {
  const { hostname, port } = new URL(base)
  return new Promise((ok, ko) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write(text)
      if (options.end === false) {
        setTimeout(() => {
          socket.destroy()
          ok('')
        }, 50)
      }
    })
    const chunks: Buffer[] = []
    socket.on('data', (c: Buffer) => chunks.push(c))
    socket.on('end', () => ok(Buffer.concat(chunks).toString()))
    socket.on('error', ko)
  })
}

describe('edge request targets', () => {
  it('builds upstream URLs that keep the upstream host', () => {
    expect(upstreamUrl('http://127.0.0.1:4100', '/api/v1/ports?region=EU').href).toBe('http://127.0.0.1:4100/api/v1/ports?region=EU')
    expect(upstreamUrl('http://127.0.0.1:4100/base/', '/x').href).toBe('http://127.0.0.1:4100/base/x')
    expect(() => upstreamUrl('http://127.0.0.1:4100', '//10.0.0.5:8080/internal')).toThrow(/origin-form/)
    expect(() => upstreamUrl('http://127.0.0.1:4100', 'http://10.0.0.5:8080/internal')).toThrow(/origin-form/)
  })

  it('answers 400 to scheme-relative and absolute-form targets and never reaches the other host', async () => {
    let internalHits = 0
    const internal = createServer((_, res) => {
      internalHits += 1
      res.end('secret')
    })
    const legacy = echo('legacy')
    const i = await listen(internal)
    const l = await listen(legacy)
    const edge = createEdge({
      config: parseConfig(yaml(l, l, '  - { match: "GET /x", to: service }')),
      shadowDir: mkdtempSync(join(tmpdir(), 'fig-shadow-')),
      log: () => {},
    })
    const base = await listen(edge)
    const host = new URL(i).host
    for (const target of [`//${host}/internal`, `http://${host}/internal`]) {
      const answer = await raw(base, `GET ${target} HTTP/1.1\r\nHost: edge\r\nConnection: close\r\n\r\n`)
      expect(answer).toMatch(/^HTTP\/1\.1 400 /)
      expect(answer).toContain('BAD_REQUEST')
      expect(answer).not.toContain('secret')
    }
    expect(internalHits).toBe(0)
    // An ordinary request still goes through.
    expect((await fetch(`${base}/x`)).headers.get('x-upstream')).toBe('legacy')
    await Promise.all([close(edge), close(legacy), close(internal)])
  })
})

describe('edge failures stay inside the request', () => {
  it('survives a caller that hangs up halfway through the body', async () => {
    const legacy = echo('legacy')
    const l = await listen(legacy)
    const lines: Record<string, unknown>[] = []
    const edge = createEdge({
      config: parseConfig(yaml(l, l, '  - { match: "POST /q", to: legacy }')),
      shadowDir: mkdtempSync(join(tmpdir(), 'fig-shadow-')),
      log: (line) => lines.push(line),
    })
    const base = await listen(edge)
    await raw(base, 'POST /q HTTP/1.1\r\nHost: edge\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"from":', { end: false })
    await new Promise((r) => setTimeout(r, 50))
    // Node reports the hang-up as an 'aborted' error on the request; it is logged, not thrown.
    expect(lines).toContainEqual(expect.objectContaining({ route: 'edge', url: '/q', error: expect.any(String) }))
    // The edge is still up.
    expect((await fetch(`${base}/q`, { method: 'POST', body: '{}' })).status).toBe(200)
    await Promise.all([close(edge), close(legacy)])
  })

  it('keeps answering shadowed callers when the shadow log cannot be written', async () => {
    const legacy = echo('legacy')
    const service = echo('service')
    const l = await listen(legacy)
    const s = await listen(service)
    const shadowDir = mkdtempSync(join(tmpdir(), 'fig-shadow-'))
    // The log file's name is taken by a directory, so every append fails with EISDIR.
    mkdirSync(join(shadowDir, 'get-x.jsonl'))
    const lines: Record<string, unknown>[] = []
    const edge = createEdge({ config: parseConfig(yaml(l, s, '  - { match: "GET /x", to: shadow }')), shadowDir, log: (line) => lines.push(line) })
    const base = await listen(edge)
    for (let n = 0; n < 2; n++) {
      const res = await fetch(`${base}/x`)
      expect(res.status).toBe(200)
      expect(((await res.json()) as { from: string }).from).toBe('legacy')
    }
    await new Promise((r) => setTimeout(r, 50))
    expect(lines.filter((l) => String(l.error).startsWith('shadow log failed')).length).toBe(2)
    await Promise.all([close(edge), close(legacy), close(service)])
  })
})
