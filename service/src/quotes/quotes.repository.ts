import { Inject, Injectable } from '@nestjs/common'

import { DB, type Db } from '../db/database.ts'
import type { Lane } from './pricing.ts'

export interface QuoteRow {
  id: number
  customer_id: number | null
  origin: string
  dest: string
  container: string
  weight_kg: number | null
  hazardous: number
  depart: string
  total: number
  breakdown: string
  created_at: string
  expires_at: string
}

export interface CustomerRow {
  id: number
  name: string
  tier: string
}

@Injectable()
export class QuotesRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The lane as priced, or its reverse marked so the 5% applies (Q1). */
  lane(from: string, to: string, container: string): Lane | null {
    const q = this.db.prepare('SELECT base_cents FROM lanes WHERE origin = ? AND dest = ? AND container = ?')
    const direct = q.get(from, to, container) as { base_cents: number } | undefined
    if (direct) return { baseCents: direct.base_cents, reversed: false }
    const back = q.get(to, from, container) as { base_cents: number } | undefined
    return back ? { baseCents: back.base_cents, reversed: true } : null
  }

  /** The latest fuel percentage published on or before the month, or 0 (Q8). */
  fuel(month: string): number {
    const row = this.db.prepare('SELECT pct FROM fuel WHERE month <= ? ORDER BY month DESC LIMIT 1').get(month) as { pct: number } | undefined
    return row ? row.pct : 0
  }

  customer(id: number): CustomerRow | null {
    // NaN binds as NULL in SQLite, which matches nothing, like the legacy lookup.
    return (this.db.prepare('SELECT id, name, tier FROM customers WHERE id = ?').get(id) as CustomerRow | undefined) ?? null
  }

  insert(q: Omit<QuoteRow, 'id'>): QuoteRow {
    const info = this.db
      .prepare(
        'INSERT INTO quotes (customer_id, origin, dest, container, weight_kg, hazardous, depart, total, breakdown, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(q.customer_id, q.origin, q.dest, q.container, q.weight_kg, q.hazardous, q.depart, q.total, q.breakdown, q.created_at, q.expires_at)
    return this.find(Number(info.lastInsertRowid))!
  }

  find(id: number): QuoteRow | null {
    return (this.db.prepare('SELECT * FROM quotes WHERE id = ?').get(id) as QuoteRow | undefined) ?? null
  }
}
