import { describe, expect, it, vi } from 'vitest'

import { diffJson, compareResponses } from '../parity/src/diff.ts'
import { loadCorpus, routes } from '../parity/src/corpus.ts'
import { replay } from '../parity/src/harness.ts'
import type * as Pricing from '../service/src/quotes/pricing.ts'

// A plausible porting mistake: the reverse-lane surcharge (Q1) is dropped.
// Only the quote test below turns it on.
const broken = vi.hoisted(() => ({ on: false }))
vi.mock('../service/src/quotes/pricing.ts', async (importOriginal) => {
  const real = await importOriginal<typeof Pricing>()
  return {
    ...real,
    price: (lane: Parameters<typeof real.price>[0], ...rest: Parameters<typeof real.price> extends [unknown, ...infer R] ? R : never) =>
      real.price(broken.on ? { ...lane, reversed: false } : lane, ...rest),
  }
})

describe('diff', () => {
  it('ignores key order but not types', () => {
    expect(diffJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toEqual([])
    expect(diffJson({ total: 1982 }, { total: '1982' })).toEqual([{ path: '$.total', legacy: 1982, service: '1982' }])
  })

  it('reports missing keys and array lengths', () => {
    const d = diffJson({ ok: true, list: [1, 2] }, { list: [1] })
    expect(d.map((x) => x.path)).toEqual(['$.list.length', '$.ok'])
  })

  it('only ignores the exact paths it is given', () => {
    const a = { quote: { id: 1, created: 'x', total: 1 } }
    const b = { quote: { id: 2, created: 'y', total: 2 } }
    expect(diffJson(a, b, '$', ['$.quote.created']).map((x) => x.path)).toEqual(['$.quote.id', '$.quote.total'])
    expect(diffJson({ l: [{ id: 1 }, { id: 2 }] }, { l: [{ id: 3 }, { id: 4 }] }, '$', ['$.l[*].id'])).toEqual([])
  })

  it('compares status, content type and raw bodies for non-JSON', () => {
    const legacy = { status: 200, headers: { 'content-type': 'application/javascript; charset=utf-8' }, body: 'cb({})' }
    const d = compareResponses(legacy, { ...legacy, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{}' })
    expect(d.map((x) => x.path)).toEqual(['header content-type', 'body'])
  })
})

describe('corpus', () => {
  it('every corpus parses and has its recording', () => {
    for (const r of routes()) expect(loadCorpus(r).cases.length).toBeGreaterThan(0)
  })
})

describe('replay', () => {
  it.each(['ports', 'quote', 'bookings-get'])('%s passes against the service', async (route) => {
    const report = await replay(route, { write: false })
    expect(report.counts.different).toBe(0)
    expect(report.passed).toBe(true)
  })

  it('reports the intentional difference instead of hiding it', async () => {
    const report = await replay('bookings-get', { write: false })
    const accepted = report.cases.filter((c) => c.outcome === 'accepted')
    expect(accepted).toHaveLength(2)
    expect(accepted[0]!.differences.find((d) => d.path === 'status')).toEqual({ path: 'status', legacy: 200, service: 404 })
  })

  it('fails with a readable diff when a rule is broken on purpose', async () => {
    broken.on = true
    try {
      const report = await replay('quote', { write: false })
      expect(report.passed).toBe(false)
      const names = report.cases.filter((c) => c.outcome === 'different').map((c) => c.name)
      expect(names).toContain('reverse lane costs 5% more (Q1)')
      expect(names).not.toContain('plain 20DV quote')
      const diff = report.cases.find((c) => c.name === 'reverse lane costs 5% more (Q1)')!.differences
      expect(diff).toContainEqual({ path: '$.quote.breakdown.base', legacy: '1911.00', service: '1820.00' })
    } finally {
      broken.on = false
    }
  })
})
