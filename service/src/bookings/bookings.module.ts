import { Module } from '@nestjs/common'

import { BookingsController } from './bookings.controller.ts'

@Module({ controllers: [BookingsController] })
export class BookingsModule {}
