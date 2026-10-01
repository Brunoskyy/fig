import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
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

export function send(base: string, req: { method: string; url: string; headers: IncomingHttpHeaders }, body: Buffer, timeoutMs: number, extra: Record<string, string>): Promise<Upstreamed> {
  const target = new URL(req.url, base)
  return new Promise((resolvePromise, reject) => {
    const out = httpRequest(
      target,
      {
        method: req.method,
        headers: { ...forwardHeaders(req.headers, extra), ...(body.length ? { 'content-length': String(body.length) } : {}) },
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
    out.end(body)
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
  })
}

const flat = (headers: IncomingHttpHeaders): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]))

export function captured(u: Upstreamed): Captured {
  return { status: u.status, headers: flat(u.headers), body: u.body.toString('utf8') }
}

function reply(res: ServerResponse, u: Upstreamed, route: Target): void {
  const headers: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(u.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k) || k === 'content-length') continue
    headers[k] = v
  }
  headers['content-length'] = String(u.body.length)
  headers['x-fig-route'] = route
  res.writeHead(u.status, headers)
  res.end(u.body)
}

function fail(res: ServerResponse, status: number, message: string, requestId: string): void {
  const body = JSON.stringify({ error: { code: status === 504 ? 'UPSTREAM_TIMEOUT' : status === 413 ? 'TOO_LARGE' : 'UPSTREAM_UNREACHABLE', message } })
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'x-request-id': requestId, 'x-fig-route': 'edge' })
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

  return createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET'
      const url = req.url ?? '/'
      const path = url.split('?')[0]!
      const header = req.headers['x-request-id']
      const requestId = typeof header === 'string' && header.length > 0 && header.length <= 100 ? header : randomUUID()
      const route = resolve(routes, method, path)
      const target: Target = route?.to ?? config.default
      const started = Date.now()
      const extra = { 'x-request-id': requestId, 'x-forwarded-for': req.socket.remoteAddress ?? '' }

      const body = await readBody(req, config.maxBodyBytes)
      if (body === null) {
        fail(res, 413, `body larger than ${config.maxBodyBytes} bytes`, requestId)
        return
      }
      const message = { method, url, headers: req.headers }

      try {
        if (target === 'shadow') {
          const [legacy, service] = await Promise.allSettled([
            send(config.upstreams.legacy, message, body, config.timeoutMs, extra),
            send(config.upstreams.service, message, body, config.timeoutMs, extra),
          ])
          if (legacy.status === 'rejected') throw legacy.reason
          reply(res, legacy.value, 'shadow')
          const differences =
            service.status === 'fulfilled'
              ? compareResponses(captured(legacy.value), captured(service.value), { ignore: route?.ignore ?? [] })
              : [{ path: 'service', legacy: 'answered', service: String((service.reason as Error).message) }]
          if (differences.length) {
            const record: ShadowRecord = { time: new Date().toISOString(), requestId, route: route!.match, method, url, differences: differences.slice(0, 20) }
            appendFileSync(join(options.shadowDir, `${route!.match.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.jsonl`), JSON.stringify(record) + '\n')
          }
          log({ requestId, method, url, route: 'shadow', status: legacy.value.status, differences: differences.length, ms: Date.now() - started })
          return
        }
        const upstream = target === 'service' ? config.upstreams.service : config.upstreams.legacy
        const answer = await send(upstream, message, body, config.timeoutMs, extra)
        reply(res, answer, target)
        log({ requestId, method, url, route: target, status: answer.status, ms: Date.now() - started })
      } catch (e) {
        const timeout = e instanceof UpstreamError && e.kind === 'timeout'
        fail(res, timeout ? 504 : 502, (e as Error).message, requestId)
        log({ requestId, method, url, route: target, status: timeout ? 504 : 502, error: (e as Error).message })
      }
    })()
  })
}
