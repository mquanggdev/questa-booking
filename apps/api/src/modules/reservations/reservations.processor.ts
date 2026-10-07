import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { AppConfigService } from '../../config/app-config.service.js';
import {
  RESERVATIONS_QUEUE,
  ReservationJob,
  type ExpireOrderData,
} from '../../queue/queue.constants.js';
import { HoldGateService } from './gate/hold-gate.service.js';
import { ReleaseService } from './release.service.js';

/**
 * Runs only in the worker process (worker.ts), never in the API, so slow
 * background work cannot steal CPU from user requests.
 */
@Processor(RESERVATIONS_QUEUE)
export class ReservationsProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(ReservationsProcessor.name);

  constructor(
    private readonly release: ReleaseService,
    private readonly gate: HoldGateService,
    private readonly config: AppConfigService,
    @InjectQueue(RESERVATIONS_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  /**
   * Repeating jobs. upsertJobScheduler is idempotent: every worker start (or
   * several workers) keeps exactly one schedule per id.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      ReservationJob.SWEEP_EXPIRED,
      { every: this.config.get('SWEEP_EVERY_MS') },
      { name: ReservationJob.SWEEP_EXPIRED },
    );
    await this.queue.upsertJobScheduler(
      ReservationJob.RECONCILE_STANDING,
      { every: this.config.get('RECONCILE_EVERY_MS') },
      { name: ReservationJob.RECONCILE_STANDING },
    );
    this.logger.log('Reservation schedules registered');
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case ReservationJob.EXPIRE_ORDER: {
        const { orderId } = job.data as ExpireOrderData;
        // false = already paid, cancelled or expired by the sweep: nothing to do.
        return { released: await this.release.expire(orderId) };
      }
      case ReservationJob.SWEEP_EXPIRED:
        return { released: await this.release.sweep() };
      case ReservationJob.RECONCILE_STANDING:
        return this.gate.reconcile();
      default:
        this.logger.warn(`Unknown job ${job.name}`);
        return null;
    }
  }
}
