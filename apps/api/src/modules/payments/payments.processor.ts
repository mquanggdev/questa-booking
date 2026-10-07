import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { UnrecoverableError, type Job, type Queue } from 'bullmq';
import { AppConfigService } from '../../config/app-config.service.js';
import {
  PAYMENTS_QUEUE,
  PaymentJob,
  type CancelPerformanceData,
  type RefundJobData,
} from '../../queue/queue.constants.js';
import { PerformanceCancellationService } from './performance-cancellation.service.js';
import { PermanentRefundError } from './providers/payment-provider.js';
import { RefundsService } from './refunds.service.js';

/** Runs in the worker process only (worker.module.ts). */
@Processor(PAYMENTS_QUEUE)
export class PaymentsProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(PaymentsProcessor.name);

  constructor(
    private readonly refunds: RefundsService,
    private readonly cancellation: PerformanceCancellationService,
    private readonly config: AppConfigService,
    @InjectQueue(PAYMENTS_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      PaymentJob.SWEEP,
      { every: this.config.get('SWEEP_EVERY_MS') },
      { name: PaymentJob.SWEEP },
    );
    this.logger.log('Payment schedules registered');
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case PaymentJob.REFUND:
        return this.refund(job as Job<RefundJobData>);
      case PaymentJob.CANCEL_PERFORMANCE: {
        const { performanceId } = job.data as CancelPerformanceData;
        return this.cancellation.run(performanceId);
      }
      case PaymentJob.SWEEP:
        return {
          refundsRequeued: await this.refunds.requeueStale(),
          cancellationsResumed: await this.cancellation.resumeUnfinished(),
        };
      default:
        this.logger.warn(`Unknown job ${job.name}`);
        return null;
    }
  }

  /**
   * One attempt. On the last attempt, or when the gateway refused for good,
   * the refund is marked FAILED and copied to the dead letter queue.
   */
  private async refund(job: Job<RefundJobData>): Promise<void> {
    const { refundId } = job.data;
    try {
      await this.refunds.process(refundId);
    } catch (error) {
      const permanent = error instanceof PermanentRefundError;
      // attemptsMade counts the attempts that already failed, not this one.
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (permanent || lastAttempt) {
        await this.refunds.markFailed(refundId, error);
      } else {
        await this.refunds.recordError(refundId, error);
      }
      if (permanent) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }
}
