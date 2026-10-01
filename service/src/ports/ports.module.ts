import { Module } from '@nestjs/common'

import { PortsController } from './ports.controller.ts'

@Module({ controllers: [PortsController] })
export class PortsModule {}
