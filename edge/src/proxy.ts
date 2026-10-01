import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'

import { compareResponses, type Captured } from '../../parity/src/diff.ts'
import { compile, resolve, type EdgeConfig, type Target } from './routes.ts'

/** Headers that describe one connection, not the message, and must not be forwarded (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export interface Upstreamed {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

export class UpstreamError extends Error {
  constructor(
    readonly kind: 'timeout' | 'unreachable',
    message: string,
  ) {
    super(message)
  }
}

function forwardHeaders(headers: IncomingHttpHeaders, extra: Record<string, string>): Record<string, string | string[]> {
  const listed = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  )
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || HOP_BY_HOP.has(k) || listed.has(k) || k === 'host' || k === 'content-length') continue
    out[k] = v
  }
  return { ...out, ...extra }
}

/**
 * Only origin-form targets ("/path?query") are proxied. An absolute-form
 * target ("http://other/x") or a scheme-relative one ("//other/x") would make
 * `new URL(target, base)` replace the upstream host, turning the edge into an
 * open proxy to anything it can reach.
 */
export function isOriginForm(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//')
}

/** The upstream URL for a request: the upstream's origin and base path, then the request's path, never another host. */
export function upstreamUrl(base: string, url: string): URL {
  if (!isOriginForm(url)) throw new Error(`refusing to proxy a non origin-form target: ${url.slice(0, 100)}`)
  const b = new URL(base)
  const target = new URL(`${b.origin}${b.pathname.replace(/\/+$/, '')}${url}`)
  if (target.origin !== b.origin) throw new Error(`refusing to proxy to ${target.origin}`)
  return target
}

export function send(
  base: string,
  req: { method: string; url: string; headers: IncomingHttpHeaders },
  body: Buffer,
  timeoutMs: number,
  extra: Record<string, string>,
): Promise<Upstreamed> {
  const target = upstreamUrl(base, req.url)
  return new Promise((resolvePromise, reject) => {
    const out = httpRequest(
      target,
      {
        method: req.method,
        headers: {
          ...forwardHeaders(req.headers, extra),
          // GET and HEAD go without a length when empty; anything else always says how long it is.
          ...(body.length || !['GET', 'HEAD'].includes(req.method) ? { 'content-length': String(body.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          clearTimeout(timer)
          resolvePromise({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) })
        })
        res.on('error', (e) => {
          clearTimeout(timer)
          reject(new UpstreamError('unreachable', e.message))
        })
      },
    )
    // One deadline for the whole exchange, not per socket read: a slow
    // upstream that trickles bytes still fails on time.
    const timer = setTimeout(() => {
      out.destroy()
      reject(new UpstreamError('timeout', `${base} did not answer within ${timeoutMs} ms`))
    }, timeoutMs)
    out.on('error', (e) => {
      clearTimeout(timer)
      if (!(e instanceof UpstreamError)) reject(new UpstreamError('unreachable', e.message))
    })
    if (body.length) out.end(body)
    else out.end()
  })
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) {
        resolvePromise(null)
        req.resume()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolvePromise(size > max ? null : Buffer.concat(chunks)))
    req.on('error', reject)
    // A caller that hangs up mid-body may never emit 'end'; settle anyway.
    req.on('close', () => {
      if (!req.complete) reject(new Error('client closed the request before the body ended'))
    })
  })
}

const flat = (headers: IncomingHttpHeaders): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]))

export function captured(u: Upstreamed): Captured {
  return { status: u.status, headers: flat(u.headers), body: u.body.toString('utf8') }
}

function reply(res: ServerResponse, u: Upstreamed, route: Target, method: string): void {
  const headers: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(u.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k)) continue
    if (k === 'content-length' && method !== 'HEAD') continue
    headers[k] = v
  }
  // The body was buffered, so its length is known. HEAD keeps the upstream's
  // length (there is no body to measure), and 204/304 must not have one.
  if (method !== 'HEAD' && u.status !== 204 && u.status !== 304) headers['content-length'] = String(u.body.length)
  headers['x-fig-route'] = route
  res.writeHead(u.status, headers)
  res.end(u.body)
}

function fail(res: ServerResponse, status: number, message: string, requestId: string): void {
  // Too late for an error response once the reply started: cut the connection
  // so the caller sees a truncated answer instead of a corrupted one.
  if (res.headersSent) {
    res.destroy()
    return
  }
  const code = { 400: 'BAD_REQUEST', 413: 'TOO_LARGE', 504: 'UPSTREAM_TIMEOUT' }[status] ?? 'UPSTREAM_UNREACHABLE'
  const body = JSON.stringify({ error: { code, message } })
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-request-id': requestId,
    'x-fig-route': 'edge',
  })
  res.end(body)
}

export interface EdgeOptions {
  config: EdgeConfig
  /** Where shadow diffs are appended, one JSON line per mismatching request. */
  shadowDir: string
  log?: (line: Record<string, unknown>) => void
}

export interface ShadowRecord {
  time: string
  requestId: string
  route: string
  method: string
  url: string
  differences: ReturnType<typeof compareResponses>
}

/**
 * The strangler edge. Every request is routed by routes.yaml to the legacy
 * app, the new service, or both (shadow): in shadow mode the legacy answer
 * goes back to the caller and the service's is compared with it and logged.
 * A failing service never affects a shadowed caller.
 */
export function createEdge(options: EdgeOptions): Server {
  const { config } = options
  const routes = compile(config.routes)
  const log = options.log ?? ((l) => process.stdout.write(JSON.stringify(l) + '\n'))
  mkdirSync(options.shadowDir, { recursive: true })

  const shadowFile = (match: string) => join(options.shadowDir, `${match.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.jsonl`)

  /** Compares and logs a shadowed request after the caller has its answer. Never throws. */
  async function compareShadow(
    route: { match: string; ignore?: string[] },
    legacy: Upstreamed,
    pending: Promise<{ ok: true; value: Upstreamed } | { ok: false; error: Error }>,
    meta: { requestId: string; method: string; url: string },
  ): Promise<void> {
    try {
      const service = await pending
      const differences = service.ok
        ? compareResponses(captured(legacy), captured(service.value), { ignore: route.ignore ?? [] })
        : [{ path: 'service', legacy: 'answered', service: service.error.message }]
      if (!differences.length) return
      const record: ShadowRecord = { time: new Date().toISOString(), ...meta, route: route.match, differences: differences.slice(0, 20) }
      await appendFile(shadowFile(route.match), JSON.stringify(record) + '\n')
    } catch (e) {
      log({ ...meta, route: 'shadow', error: `shadow log failed: ${(e as Error).message}` })
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
    const method = req.method ?? 'GET'
    const url = req.url ?? '/'
    if (!isOriginForm(url)) {
      req.resume()
      fail(res, 400, 'request target must be a path', requestId)
      log({ requestId, method, url: url.slice(0, 200), route: 'edge', status: 400 })
      return
    }
    const path = url.split('?')[0]!
    const route = resolve(routes, method, path)
    const target: Target = route?.to ?? config.default
    const started = Date.now()
    const prior = req.headers['x-forwarded-for']
    const client = req.socket.remoteAddress ?? ''
    const extra = { 'x-request-id': requestId, 'x-forwarded-for': prior ? `${String(prior)}, ${client}` : client }

    const body = await readBody(req, config.maxBodyBytes)
    if (body === null) {
      fail(res, 413, `body larger than ${config.maxBodyBytes} bytes`, requestId)
      return
    }
    const message = { method, url, headers: req.headers }

    try {
      if (target === 'shadow' && route) {
        // Both requests start together, but the caller waits only for legacy.
        const servicePromise = send(config.upstreams.service, message, body, config.timeoutMs, extra).then(
          (value) => ({ ok: true as const, value }),
          (error: Error) => ({ ok: false as const, error }),
        )
        const legacy = await send(config.upstreams.legacy, message, body, config.timeoutMs, extra)
        reply(res, legacy, 'shadow', method)
        log({ requestId, method, url, route: 'shadow', status: legacy.status, ms: Date.now() - started })
        // Detached: whatever happens to the comparison, the caller already has its answer.
        void compareShadow(route, legacy, servicePromise, { requestId, method, url })
        return
      }
      const upstream = target === 'service' ? config.upstreams.service : config.upstreams.legacy
      const answer = await send(upstream, message, body, config.timeoutMs, extra)
      reply(res, answer, target, method)
      log({ requestId, method, url, route: target, status: answer.status, ms: Date.now() - started })
    } catch (e) {
      const timeout = e instanceof UpstreamError && e.kind === 'timeout'
      fail(res, timeout ? 504 : 502, (e as Error).message, requestId)
      log({ requestId, method, url, route: target, status: timeout ? 504 : 502, error: (e as Error).message })
    }
  }

  return createServer((req, res) => {
    const header = req.headers['x-request-id']
    const requestId = typeof header === 'string' && header.length > 0 && header.length <= 100 ? header : randomUUID()
    // Nothing a single request does may take the process down: an aborted
    // upload, a write after the reply started, a full disk.
    handle(req, res, requestId).catch((e: unknown) => {
      log({ requestId, method: req.method, url: req.url?.slice(0, 200), route: 'edge', error: (e as Error).message })
      try {
        fail(res, 502, 'edge error', requestId)
      } catch {
        res.destroy()
      }
    })
  })
}
