import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common'

import { parseQuoteRequest } from './quote-request.ts'
import { QuotesService, type QuoteResult } from './quotes.service.ts'

@Controller('api/v1/quote')
export class QuotesController {
  constructor(@Inject(QuotesService) private readonly quotes: QuotesService) {}

  /** `200` for every business outcome, `400` for a malformed request, as before (Q9, Q11). */
  @Post()
  @HttpCode(200)
  create(@Body() body: unknown): QuoteResult {
    return this.quotes.create(parseQuoteRequest(body))
  }
}
