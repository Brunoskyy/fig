import { z } from 'zod'

import { parseDay } from '../common/clock.ts'
import { LegacyBadRequest } from '../common/legacy-errors.ts'

export const CONTAINERS = ['20DV', '40DV', '40HC', '20RF'] as const
export type Container = (typeof CONTAINERS)[number]
export const MAX_WEIGHT_KG: Record<Container, number> = {
  '20DV': 28_000,
  '40DV': 28_000,
  '40HC': 28_000,
  '20RF': 27_000,
}

/**
 * What a quote request may contain. Loose on purpose: the legacy API accepted
 * strings, numbers and flags in several spellings, and callers still send
 * all of them.
 */
const Body = z
  .object({
    from: z.unknown(),
    to: z.unknown(),
    container: z.unknown(),
    depart: z.unknown(),
    weight: z.unknown(),
    hazardous: z.unknown(),
    customer: z.unknown(),
  })
  .partial()

export interface QuoteRequest {
  from: string
  to: string
  container: Container
  depart: Date
  /** NaN when the weight is missing or not a number (Q3). */
  weightKg: number
  hazardous: boolean
  /** null when no customer was given; NaN when one was given but is not a number. */
  customerId: number | null
}

/** The flag spellings the legacy API accepted for `hazardous`. */
export function yes(v: unknown): boolean {
  // Loose equality on purpose, like the legacy check: `v == 1` also accepts "1"
  // and "01", and `v == 'Y'` also accepts ["Y"]. Callers rely on some of these.
  /* eslint-disable eqeqeq */
  const l = v as string
  return v === true || l == 'Y' || l == 'y' || l == (1 as unknown as string) || l == 'true'
  /* eslint-enable eqeqeq */
}

const present = (v: unknown) => v !== undefined && v !== null && v !== '' && v !== 0 && v !== false

/**
 * Parses a quote request with the legacy rules: the first failing field wins,
 * in the order from, to, container, depart (Q11).
 */
export function parseQuoteRequest(raw: unknown): QuoteRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    // The legacy check was `typeof b != 'object'`, which lets arrays through to "from is required".
    if (!Array.isArray(raw)) throw new LegacyBadRequest('body must be JSON')
  }
  const b = Body.parse(Array.isArray(raw) ? {} : raw)
  if (!present(b.from)) throw new LegacyBadRequest('from is required')
  if (!present(b.to)) throw new LegacyBadRequest('to is required')
  if (!present(b.container)) throw new LegacyBadRequest('container is required')
  const container = String(b.container).toUpperCase()
  if (!(CONTAINERS as readonly string[]).includes(container)) throw new LegacyBadRequest('unknown container')
  const depart = parseDay(b.depart)
  if (!depart) throw new LegacyBadRequest('depart must be YYYY-MM-DD')

  const weightKg = parseInt(String(b.weight), 10)
  const customerId = b.customer === undefined || b.customer === null || b.customer === '' ? null : parseInt(String(b.customer), 10)
  return {
    from: String(b.from).toUpperCase(),
    to: String(b.to).toUpperCase(),
    container: container as Container,
    depart,
    weightKg,
    hazardous: yes(b.hazardous),
    customerId,
  }
}
