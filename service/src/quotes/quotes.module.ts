import { Module } from '@nestjs/common'

import { QuotesController } from './quotes.controller.ts'
import { QuotesRepository } from './quotes.repository.ts'
import { QuotesService } from './quotes.service.ts'

@Module({
  controllers: [QuotesController],
  providers: [QuotesRepository, QuotesService],
})
export class QuotesModule {}
