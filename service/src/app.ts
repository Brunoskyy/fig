import 'reflect-metadata'

import { Global, Module, type DynamicModule } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import express from 'express'

import { BookingsModule } from './bookings/bookings.module.ts'
import { CLOCK, systemClock, type Clock } from './common/clock.ts'
import { LegacyErrorsFilter } from './common/legacy-errors.ts'
import { JsonLogger, requestLog } from './common/logger.ts'
import { DB, type Db } from './db/database.ts'
import { PortsModule } from './ports/ports.module.ts'
import { QuotesModule } from './quotes/quotes.module.ts'

@Global()
@Module({})
class CoreModule {
  static with(db: Db, clock: Clock): DynamicModule {
    return {
      module: CoreModule,
      providers: [
        { provide: DB, useValue: db },
        { provide: CLOCK, useValue: clock },
      ],
      exports: [DB, CLOCK],
    }
  }
}

export interface ServiceOptions {
  db: Db
  clock?: Clock
  logger?: JsonLogger
}

/** Builds the service without listening, so tests and the parity harness can start it on any port. */
export async function createService(options: ServiceOptions): Promise<NestExpressApplication> {
  @Module({ imports: [CoreModule.with(options.db, options.clock ?? systemClock), PortsModule, QuotesModule, BookingsModule] })
  class AppModule {}

  const logger = options.logger ?? new JsonLogger()
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, logger })
  app.disable('x-powered-by')
  // Express 5 parses ?a[b]=c as the key "a[b]"; the legacy app's Express 4
  // parses it with qs into objects and arrays. Callers send both kinds, so
  // the service parses queries the legacy way.
  app.set('query parser', 'extended')
  app.use(requestLog(logger))
  // Same limit as the legacy app; parse errors reach the filter as `entity.parse.failed`.
  app.use(express.json({ limit: '200kb' }))
  app.useGlobalFilters(new LegacyErrorsFilter(logger))
  await app.init()
  return app
}
