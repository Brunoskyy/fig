import { Inject, Injectable } from '@nestjs/common'

import { addDays, CLOCK, stamp, ymd, type Clock } from '../common/clock.ts'
import { price } from './pricing.ts'
import { MAX_WEIGHT_KG, type QuoteRequest } from './quote-request.ts'
import { QuotesRepository, type QuoteRow } from './quotes.repository.ts'

export type QuoteResult =
  { ok: true; quote: ReturnType<typeof quoteJson> } | { ok: false; err: 'OVERWEIGHT'; max: number } | { ok: false; err: 'NO_LANE' | 'NO_CUSTOMER' }

export function quoteJson(row: QuoteRow) {
  return {
    id: row.id,
    customer: row.customer_id,
    from: row.origin,
    to: row.dest,
    container: row.container,
    weight: row.weight_kg,
    hazardous: row.hazardous === 1,
    depart: row.depart,
    total: row.total,
    currency: 'USD' as const,
    breakdown: JSON.parse(row.breakdown) as Record<string, string>,
    created: row.created_at,
    expires: row.expires_at,
  }
}

@Injectable()
export class QuotesService {
  constructor(
    @Inject(QuotesRepository) private readonly repo: QuotesRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Same order of checks as the legacy handler: weight, customer, lane. */
  create(req: QuoteRequest): QuoteResult {
    const max = MAX_WEIGHT_KG[req.container]
    if (req.weightKg > max) return { ok: false, err: 'OVERWEIGHT', max }

    let gold = false
    let customerId: number | null = null
    if (req.customerId !== null) {
      const customer = this.repo.customer(req.customerId)
      if (!customer) return { ok: false, err: 'NO_CUSTOMER' }
      gold = customer.tier === 'gold'
      customerId = customer.id
    }

    const lane = this.repo.lane(req.from, req.to, req.container)
    if (!lane) return { ok: false, err: 'NO_LANE' }

    const p = price(lane, { weightKg: req.weightKg, hazardous: req.hazardous, depart: req.depart }, this.repo.fuel(ymd(req.depart).slice(0, 7)), gold)
    const created = this.clock.now()
    const row = this.repo.insert({
      customer_id: customerId,
      origin: req.from,
      dest: req.to,
      container: req.container,
      weight_kg: Number.isNaN(req.weightKg) ? null : req.weightKg,
      hazardous: req.hazardous ? 1 : 0,
      depart: ymd(req.depart),
      total: p.total,
      breakdown: JSON.stringify(p.breakdown),
      created_at: stamp(created),
      expires_at: ymd(addDays(created, 7)),
    })
    return { ok: true, quote: quoteJson(row) }
  }
}
