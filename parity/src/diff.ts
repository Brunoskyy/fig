/**
 * Structural comparison of two HTTP responses, shared by the parity harness
 * and the edge's shadow mode. Bodies are compared as parsed JSON when both
 * are JSON, so key order and whitespace never count, but every value does:
 * a number against the same number as a string is a difference.
 */

export interface Difference {
  /** JSON path like `$.quote.breakdown.fuel`, or `status` / `header content-type`. */
  path: string
  legacy: unknown
  service: unknown
}

export interface Captured {
  status: number
  headers: Record<string, string>
  body: string
}

export interface CompareOptions {
  /** JSON paths whose values may differ (volatile fields). Exact paths; `[*]` matches any index. */
  ignore?: readonly string[]
  /** Response headers that must match. content-type always does. */
  headers?: readonly string[]
}

const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)

function pathMatches(pattern: string, path: string): boolean {
  const re = new RegExp('^' + pattern.replace(/[.$]/g, '\\$&').replace(/\\\[\*\]|\[\*\]/g, '\\[\\d+\\]') + '$')
  return re.test(path)
}

export function diffJson(a: unknown, b: unknown, path = '$', ignore: readonly string[] = [], out: Difference[] = []): Difference[] {
  if (ignore.some((p) => pathMatches(p, path))) return out
  const ta = typeOf(a)
  const tb = typeOf(b)
  if (ta !== tb) {
    out.push({ path, legacy: a, service: b })
    return out
  }
  if (ta === 'array') {
    const xa = a as unknown[]
    const xb = b as unknown[]
    if (xa.length !== xb.length) out.push({ path: `${path}.length`, legacy: xa.length, service: xb.length })
    for (let i = 0; i < Math.min(xa.length, xb.length); i += 1) diffJson(xa[i], xb[i], `${path}[${i}]`, ignore, out)
    return out
  }
  if (ta === 'object') {
    const oa = a as Record<string, unknown>
    const ob = b as Record<string, unknown>
    const keys = [...new Set([...Object.keys(oa), ...Object.keys(ob)])].sort()
    for (const k of keys) {
      const child = `${path}.${k}`
      if (!(k in oa) || !(k in ob)) {
        if (!ignore.some((p) => pathMatches(p, child))) out.push({ path: child, legacy: oa[k], service: ob[k] })
        continue
      }
      diffJson(oa[k], ob[k], child, ignore, out)
    }
    return out
  }
  if (!Object.is(a, b)) out.push({ path, legacy: a, service: b })
  return out
}

const isJson = (contentType: string | undefined) => /\bjson\b/i.test(contentType ?? '')

function parse(body: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(body) }
  } catch {
    return { ok: false }
  }
}

export function compareResponses(legacy: Captured, service: Captured, options: CompareOptions = {}): Difference[] {
  const out: Difference[] = []
  if (legacy.status !== service.status) out.push({ path: 'status', legacy: legacy.status, service: service.status })
  for (const h of new Set(['content-type', ...(options.headers ?? [])])) {
    const a = legacy.headers[h]
    const b = service.headers[h]
    if (a !== b) out.push({ path: `header ${h}`, legacy: a, service: b })
  }
  if (isJson(legacy.headers['content-type']) && isJson(service.headers['content-type'])) {
    const a = parse(legacy.body)
    const b = parse(service.body)
    if (a.ok && b.ok) return diffJson(a.value, b.value, '$', options.ignore ?? [], out)
  }
  if (legacy.body !== service.body) out.push({ path: 'body', legacy: legacy.body, service: service.body })
  return out
}
