/**
 * Quote pricing, ported from the legacy `price` function. The arithmetic is
 * float dollars on purpose, operation for operation, because partners
 * reconcile against the totals the old system produced (QUIRKS Q4–Q7). The
 * parity recordings are the proof that it matches.
 */

export const REVERSE_LANE_FACTOR = 1.05
export const WEIGHT_FREE_KG = 20_000
export const WEIGHT_STEP_KG = 1000
export const WEIGHT_STEP_USD = 150
export const HAZARDOUS_RATE = 0.18
export const HAZARDOUS_MIN_USD = 95
export const WEEKEND_USD = 75
export const PEAK_RATE = 0.12
export const GOLD_DISCOUNT = 0.07

export interface Lane {
  baseCents: number
  /** True when only the opposite direction is on the rate card (Q1). */
  reversed: boolean
}

export interface PriceInput {
  /** NaN when the caller sent no usable weight (Q3). */
  weightKg: number
  hazardous: boolean
  depart: Date
}

export interface Breakdown {
  base: string
  weight: string
  hazardous: string
  weekend: string
  peak: string
  fuel: string
  discount: string
}

export interface Price {
  total: number
  breakdown: Breakdown
}

/** Dec 1 through Jan 14. Jan 15 is not peak, as in the legacy code (Q5). */
export function isPeak(d: Date): boolean {
  const month = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  return month === 12 || (month === 1 && day < 15)
}

export function isWeekend(d: Date): boolean {
  const dow = d.getUTCDay()
  return dow === 0 || dow === 6
}

const money = (x: number) => x.toFixed(2)

export function price(lane: Lane, input: PriceInput, fuelPct: number, goldCustomer: boolean): Price {
  let base = lane.baseCents / 100
  if (lane.reversed) base = base * REVERSE_LANE_FACTOR

  // `>` and not `>=`: exactly 20,000 kg carries no surcharge (Q2). NaN fails both.
  const weight =
    input.weightKg > WEIGHT_FREE_KG
      ? Math.ceil((input.weightKg - WEIGHT_FREE_KG) / WEIGHT_STEP_KG) * WEIGHT_STEP_USD
      : 0

  let hazardous = 0
  if (input.hazardous) {
    hazardous = base * HAZARDOUS_RATE
    if (hazardous < HAZARDOUS_MIN_USD) hazardous = HAZARDOUS_MIN_USD
  }

  const weekend = isWeekend(input.depart) ? WEEKEND_USD : 0
  const peak = isPeak(input.depart) ? (base + weight) * PEAK_RATE : 0
  const fuel = base * fuelPct

  const sub = base + weight + weekend + peak + fuel
  // The gold discount leaves the hazardous surcharge alone (Q4).
  const discount = goldCustomer ? sub * GOLD_DISCOUNT : 0

  // Round up to the next 5 cents, float noise included (Q6).
  const total = Math.ceil((sub - discount + hazardous) * 20) / 20

  return {
    total: Number(total.toFixed(2)),
    breakdown: {
      base: money(base),
      weight: money(weight),
      hazardous: money(hazardous),
      weekend: money(weekend),
      peak: money(peak),
      fuel: money(fuel),
      discount: money(discount),
    },
  }
}
