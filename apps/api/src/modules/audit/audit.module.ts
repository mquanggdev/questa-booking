import { Module } from '@nestjs/common';
import { AuditHandler } from './audit.handler.js';

// Worker only: the `audit` consumer of orders.events.
@Module({
  providers: [AuditHandler],
  exports: [AuditHandler],
})
export class AuditModule {}
