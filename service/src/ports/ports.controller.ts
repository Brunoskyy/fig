import { Controller, Get, Inject, Query, Res } from '@nestjs/common'
import type { Response } from 'express'

import { DB, type Db } from '../db/database.ts'

const CALLBACK = /^[a-zA-Z_$][\w$]*$/

/** The golden route: the first one ported, and the pattern the others follow. */
@Controller('api/v1/ports')
export class PortsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  list(@Query('region') region: unknown, @Query('callback') callback: unknown, @Res() res: Response): void {
    const filter = region ? String(region as string).toUpperCase() : null
    const rows = filter
      ? this.db.prepare('SELECT code, name, country, region FROM ports WHERE region = ? ORDER BY name').all(filter)
      : this.db.prepare('SELECT code, name, country, region FROM ports ORDER BY name').all()
    const body = { ok: true, count: rows.length, ports: rows }
    // JSONP for the old portal's script tag (Q10). Legacy tests the callback
    // as a string, so ?callback[]=name (an array of one) answers JSONP too.
    const name = callback ? String(callback as string) : ''
    if (name && CALLBACK.test(name)) {
      res.type('application/javascript').send(`${name}(${JSON.stringify(body)});`)
      return
    }
    res.json(body)
  }
}
