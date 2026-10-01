import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import { LegacyBadRequest } from '../service/src/common/legacy-errors.ts'
import { isPeak, price } from '../service/src/quotes/pricing.ts'
import { parseQuoteRequest, yes } from '../service/src/quotes/quote-request.ts'

const require = createRequire(import.meta.url)
const legacy = require('../legacy/app.js') as {
  price(
    lane: { base_cents: number; reversed: boolean },
    opts: { weight: number; hazardous: boolean; departDate: Date },
    fuel: number,
    customer: { tier: string } | null,
  ): unknown
  isPeak(d: Date): boolean
}

/** Small deterministic generator, so a failure is reproducible from its index. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32
    return seed / 2 ** 32
  }
}

describe('pricing against the legacy function', () => {
  it('matches legacy price() to the cent on 5,000 generated quotes', () => {
    const r = rng(42)
    for (let i = 0; i < 5000; i += 1) {
      const baseCents = Math.round(20_000 + r() * 500_000)
      const reversed = r() < 0.3
      const weight = r() < 0.1 ? NaN : Math.round(r() * 28_000)
      const hazardous = r() < 0.3
      const depart = new Date(Date.UTC(2016, 0, 1) + Math.floor(r() * 730) * 86_400_000)
      const fuel = Math.round(r() * 150) / 1000
      const gold = r() < 0.4
      const ours = price({ baseCents, reversed }, { weightKg: weight, hazardous, depart }, fuel, gold)
      const theirs = legacy.price(
        { base_cents: baseCents, reversed },
        { weight, hazardous, departDate: depart },
        fuel,
        gold ? { tier: 'gold' } : { tier: 'std' },
      )
      expect(ours, `case ${i}`).toEqual(theirs)
    }
  })

  it('agrees on peak season every day of two years', () => {
    for (let d = 0; d < 731; d += 1) {
      const day = new Date(Date.UTC(2016, 0, 1) + d * 86_400_000)
      expect(isPeak(day), day.toISOString()).toBe(legacy.isPeak(day))
    }
  })

  it('keeps the quirks it is meant to keep', () => {
    const lane = { baseCents: 182_000, reversed: false }
    const at = (weightKg: number) => price(lane, { weightKg, hazardous: false, depart: new Date('2016-11-29') }, 0, false).breakdown.weight
    expect([at(20_000), at(20_001), at(21_000), at(21_001)]).toEqual(['0.00', '150.00', '150.00', '300.00']) // Q2
    expect(isPeak(new Date('2017-01-14'))).toBe(true) // Q5
    expect(isPeak(new Date('2017-01-15'))).toBe(false)
    const cheap = price({ baseCents: 41_000, reversed: false }, { weightKg: NaN, hazardous: true, depart: new Date('2016-11-29') }, 0, true)
    expect(cheap.breakdown.hazardous).toBe('95.00') // Q4 minimum
    expect(cheap.breakdown.discount).toBe('28.70') // 7% of 410, hazardous excluded
  })
})

describe('quote request parsing', () => {
  const ok = { from: 'nlrtm', to: 'usnyc', container: '20dv', depart: '2016-11-29' }
  const detail = (body: unknown) => {
    try {
      parseQuoteRequest(body)
      return null
    } catch (e) {
      return e instanceof LegacyBadRequest ? e.detail : String(e)
    }
  }

  it('reports the first failing field, in the legacy order (Q11)', () => {
    expect(detail({})).toBe('from is required')
    expect(detail({ from: 'X' })).toBe('to is required')
    expect(detail({ from: 'X', to: 'Y' })).toBe('container is required')
    expect(detail({ from: 'X', to: 'Y', container: '53FT', depart: 'nope' })).toBe('unknown container')
    expect(detail({ ...ok, depart: '29/11/2016' })).toBe('depart must be YYYY-MM-DD')
    expect(detail([])).toBe('from is required')
    expect(detail('text')).toBe('body must be JSON')
  })

  it('parses weight and customer like parseInt (Q3)', () => {
    expect(parseQuoteRequest({ ...ok, weight: '21500kg' }).weightKg).toBe(21_500)
    expect(parseQuoteRequest({ ...ok, weight: 'heavy' }).weightKg).toBeNaN()
    expect(parseQuoteRequest({ ...ok, customer: '' }).customerId).toBeNull()
    expect(parseQuoteRequest({ ...ok, customer: '4x' }).customerId).toBe(4)
    expect(parseQuoteRequest(ok).container).toBe('20DV')
  })

  it('accepts the loose hazardous spellings and nothing else', () => {
    expect([true, 'Y', 'y', 1, '1', 'true'].map(yes)).toEqual([true, true, true, true, true, true])
    expect([false, 'N', 'yes', 0, null, undefined, 'TRUE'].map(yes)).toEqual([false, false, false, false, false, false, false])
  })
})
