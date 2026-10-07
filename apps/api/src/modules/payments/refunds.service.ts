import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { AppConfigService } from '../../config/app-config.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  PAYMENTS_DEAD_LETTER_QUEUE,
  PAYMENTS_QUEUE,
  PaymentJob,
  refundJobId,
  type RefundJobData,
} from '../../queue/queue.constants.js';
import { OrdersService } from '../orders/orders.service.js';
import { PaymentProvidersService } from './providers/payment-providers.service.js';

/** A refund older than this without progress is enqueued again by the sweep. */
const STALE_AFTER_SECONDS = 60;
const SWEEP_BATCH = 500;

/**
 * Refunds go through BullMQ (spec, flow B step 7): the gateway call can fail
 * or time out, so each refund is a job retried with exponential backoff, and
 * after REFUND_MAX_ATTEMPTS it lands in a dead letter queue for a human.
 *
 * The refunds row is the source of truth, written in the same transaction
 * that decided the money must go back; the job only carries its id. If the
 * enqueue is lost, the sweep finds the PENDING row and enqueues it again.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly providers: PaymentProvidersService,
    private readonly config: AppConfigService,
    @InjectQueue(PAYMENTS_QUEUE) private readonly queue: Queue,
    @InjectQueue(PAYMENTS_DEAD_LETTER_QUEUE)
    private readonly deadLetters: Queue,
  ) {}

  /**
   * Records that a succeeded payment must be refunded, inside the caller's
   * transaction. Unique payment_id: a payment is refunded at most once.
   */
  async create(
    tx: Prisma.TransactionClient,
    paymentId: string,
    amount: number,
    reason: string,
  ): Promise<string> {
    const refund = await tx.refund.create({
      data: { paymentId, amount, reason },
      select: { id: true },
    });
    return refund.id;
  }

  /** Enqueues refunds once the transaction that created them has committed. */
  async enqueue(refundIds: string[]): Promise<void> {
    for (const refundId of refundIds) {
      try {
        await this.queue.add(
          PaymentJob.REFUND,
          { refundId } satisfies RefundJobData,
          {
            jobId: refundJobId(refundId),
            attempts: this.config.get('REFUND_MAX_ATTEMPTS'),
            backoff: { type: 'exponential', delay: 1000 },
          },
        );
      } catch (error) {
        // The row is PENDING in PostgreSQL; the sweep will enqueue it again.
        this.logger.warn(
          `Could not enqueue refund ${refundId}: ${String(error)}`,
        );
      }
    }
  }

  /**
   * One attempt at one refund (the job body). Throws to be retried;
   * PermanentRefundError means retrying is pointless.
   */
  async process(refundId: string): Promise<void> {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      select: {
        id: true,
        status: true,
        amount: true,
        reason: true,
        payment: {
          select: {
            orderId: true,
            provider: true,
            txnRef: true,
            providerTxnId: true,
            rawPayload: true,
          },
        },
      },
    });
    if (!refund || refund.status !== 'PENDING') return;

    await this.prisma.$executeRaw`
      UPDATE refunds SET attempts = attempts + 1, updated_at = now()
      WHERE id = ${refundId}::uuid
    `;
    const payment = refund.payment;
    const provider = this.providers.get(payment.provider);
    const raw = (payment.rawPayload ?? {}) as Record<string, unknown>;
    const providerRefundId = await provider.refund({
      refundId,
      txnRef: payment.txnRef,
      amountVnd: refund.amount,
      providerTxnId: payment.providerTxnId ?? '',
      payDate: typeof raw.vnp_PayDate === 'string' ? raw.vnp_PayDate : '',
      reason: refund.reason,
    });

    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.$executeRaw`
        UPDATE refunds
        SET status = 'SUCCEEDED', provider_refund_id = ${providerRefundId},
            completed_at = now(), last_error = NULL, updated_at = now()
        WHERE id = ${refundId}::uuid AND status = 'PENDING'
      `;
      if (changed === 0) return;
      // The order is REFUNDED once none of its refunds is still pending
      // (an order normally has one; a customer who paid twice has two).
      const pending = await tx.refund.count({
        where: {
          status: { not: 'SUCCEEDED' },
          payment: { orderId: payment.orderId },
        },
      });
      if (pending === 0) {
        await this.orders.markRefunded(tx, payment.orderId);
      }
    });
  }

  /** Keeps the latest error on the row, for whoever looks at it later. */
  async recordError(refundId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.prisma.$executeRaw`
      UPDATE refunds SET last_error = ${message.slice(0, 1000)}, updated_at = now()
      WHERE id = ${refundId}::uuid AND status = 'PENDING'
    `;
  }

  /** Out of attempts (or refused for good): FAILED, and a copy to the DLQ. */
  async markFailed(refundId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const changed = await this.prisma.$executeRaw`
      UPDATE refunds
      SET status = 'FAILED', last_error = ${message.slice(0, 1000)}, updated_at = now()
      WHERE id = ${refundId}::uuid AND status = 'PENDING'
    `;
    if (changed === 0) return;
    this.logger.error(`Refund ${refundId} failed for good: ${message}`);
    await this.deadLetters.add(
      PaymentJob.REFUND,
      { refundId, error: message, failedAt: new Date().toISOString() },
      { jobId: refundJobId(refundId), removeOnComplete: false },
    );
  }

  /** Safety net: PENDING refunds that have not moved for a while. */
  async requeueStale(): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM refunds
      WHERE status = 'PENDING'
        AND updated_at < now() - ${STALE_AFTER_SECONDS} * interval '1 second'
      ORDER BY created_at
      LIMIT ${SWEEP_BATCH}
    `;
    const lost: string[] = [];
    for (const { id } of rows) {
      const job = await this.queue.getJob(refundJobId(id));
      if (job && (await job.isFailed())) {
        // The job gave up but the process died before recording it.
        await this.markFailed(id, job.failedReason);
      } else {
        lost.push(id);
      }
    }
    // Same job id as the original: a job still waiting or retrying is not
    // duplicated, BullMQ ignores the add.
    await this.enqueue(lost);
    return rows.length;
  }
}
