import { Controller, Get, Inject, Param } from '@nestjs/common'

import { NotFound } from '../common/legacy-errors.ts'
import { DB, type Db } from '../db/database.ts'

interface BookingRow {
  id: number
  quote_id: number
  customer_id: number | null
  status: string
  created_at: string
  cancelled_at: string | null
  fee: number | null
}

/**
 * Ported in shadow mode. The found case matches the legacy response; the
 * missing case is a deliberate fix (Q9): a real 404 instead of
 * `200 {"ok": false}`.
 */
@Controller('api/v1/bookings')
export class BookingsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get(':id')
  find(@Param('id') id: string) {
    const row = this.db.prepare('SELECT * FROM bookings WHERE id = ?').get(parseInt(id, 10)) as BookingRow | undefined
    if (!row) throw new NotFound(`booking ${id}`)
    return {
      ok: true,
      booking: {
        id: row.id,
        quote: row.quote_id,
        customer: row.customer_id,
        status: row.status,
        created: row.created_at,
        cancelled: row.cancelled_at ?? null,
        fee: row.fee ?? null,
      },
    }
  }
}
