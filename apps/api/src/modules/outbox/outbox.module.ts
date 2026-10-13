import { Module } from '@nestjs/common';
import { OutboxService } from './outbox.service.js';

// Writers (API and worker) use OutboxService. The relay lives in the worker
// only (OutboxRelayService, added by worker.module.ts).
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
