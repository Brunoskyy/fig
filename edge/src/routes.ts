import { readFileSync } from 'node:fs'

import { parse } from 'yaml'
import { z } from 'zod'

/** Where a route's traffic goes: the old system, the new one, or both with the old one answering. */
export type Target = 'legacy' | 'service' | 'shadow'

const SAFE = new Set(['GET', 'HEAD'])

const Route = z.object({
  match: z.string().regex(/^(GET|HEAD|POST|PUT|PATCH|DELETE) \/\S*$/, 'match must look like "GET /api/v1/ports/:code"'),
  to: z.enum(['legacy', 'service', 'shadow']),
  /** JSON paths shadow mode should not report, for fields that differ by design. */
  ignore: z.array(z.string()).optional(),
  note: z.string().optional(),
})

const Config = z.object({
  upstreams: z.object({ legacy: z.string().url(), service: z.string().url() }),
  timeoutMs: z.number().int().positive().max(60_000).default(5000),
  maxBodyBytes: z.number().int().positive().default(1_048_576),
  default: z.enum(['legacy', 'service']).default('legacy'),
  routes: z.array(Route).default([]),
})

export type RouteConfig = z.infer<typeof Route>
export type EdgeConfig = z.infer<typeof Config>

export interface CompiledRoute extends RouteConfig {
  method: string
  pattern: RegExp
}

/**
 * Reads and checks routes.yaml. Shadow mode sends the same request to both
 * systems; on a method that writes, that would write twice to the shared
 * database, so it is refused here rather than discovered in production.
 */
export function parseConfig(text: string): EdgeConfig {
  const config = Config.parse(parse(text))
  for (const r of config.routes) {
    const method = r.match.split(' ')[0]!
    if (r.to === 'shadow' && !SAFE.has(method)) {
      throw new Error(`${r.match}: shadow mode is only allowed for GET and HEAD, it would write twice`)
    }
  }
  return config
}

export function loadConfig(file: string): EdgeConfig {
  return parseConfig(readFileSync(file, 'utf8'))
}

export function compile(routes: readonly RouteConfig[]): CompiledRoute[] {
  return routes.map((r) => {
    const [method, path] = r.match.split(' ') as [string, string]
    const source = path
      .split('/')
      .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/')
    return { ...r, method, pattern: new RegExp(`^${source}/?$`) }
  })
}

/** The first route whose method and path match; HEAD falls back to a GET route. */
export function resolve(routes: readonly CompiledRoute[], method: string, path: string): CompiledRoute | null {
  const exact = routes.find((r) => r.method === method && r.pattern.test(path))
  if (exact) return exact
  if (method === 'HEAD') return routes.find((r) => r.method === 'GET' && r.pattern.test(path)) ?? null
  return null
}
