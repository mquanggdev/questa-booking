import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { RedisEventPublisher } from '../../redis/redis-event-publisher.js';
import { REDIS } from '../../redis/redis.module.js';
import {
  PerformancesService,
  type AdmissionInfo,
} from '../concerts/performances.service.js';
import { QueueState, type QueueStatusDto } from './dto/queue-status.dto.js';
import { estimateWaitMs, pollAfterMs } from './queue-estimate.js';
import {
  LINE_KEY_TTL_SECONDS,
  lineRoom,
  personRoom,
  QUEUE_NAMESPACE,
  QueueEvent,
  WaitingRoomKey,
  type QueueAdmittedEvent,
  type QueuePositionEvent,
} from './waiting-room.constants.js';
import { admitScript, joinScript } from './waiting-room.scripts.js';

export interface AdmitResult {
  performanceId: string;
  admitted: number;
  admittedThrough: number;
  waiting: number;
}

/**
 * Virtual waiting room (spec, "Hàng chờ ảo"). When a performance has it
 * turned on, buyers join a line in Redis (first come, first served) and the
 * worker admits a fixed number per tick while a sale phase is open. An
 * admitted buyer gets a pass bound to the account and the performance,
 * valid WAITING_ROOM_PASS_TTL_SECONDS; holding tickets requires it.
 *
 * The waiting room protects the system and makes the sale fair; it does
 * not protect an invariant. So when Redis fails, holds are let through
 * (fail open) and PostgreSQL still decides every hold (ADR-0010, ADR-0016).
 */
@Injectable()
export class WaitingRoomService {
  private readonly logger = new Logger(WaitingRoomService.name);
  private readonly publisher: RedisEventPublisher;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly performances: PerformancesService,
    private readonly config: AppConfigService,
  ) {
    this.publisher = new RedisEventPublisher(redis, QUEUE_NAMESPACE);
  }

  /** Join the line, or get your current place if already in it or admitted. */
  async join(performanceId: string, userId: string): Promise<QueueStatusDto> {
    const info = await this.visible(performanceId);
    if (!info.waitingRoomEnabled) {
      throw new AppException(
        HttpStatus.CONFLICT,
        ErrorCode.WAITING_ROOM_DISABLED,
        'This performance has no waiting room: hold tickets directly',
      );
    }
    if (info.status !== 'PUBLISHED' || !info.saleAhead) {
      throw new AppException(
        HttpStatus.CONFLICT,
        ErrorCode.SALE_NOT_OPEN,
        'There is no sale left for this performance',
      );
    }
    return this.run(performanceId, userId, true, info);
  }

  async status(performanceId: string, userId: string): Promise<QueueStatusDto> {
    const info = await this.visible(performanceId);
    if (!info.waitingRoomEnabled) {
      return { status: QueueState.NOT_REQUIRED };
    }
    return this.run(performanceId, userId, false, info);
  }

  /**
   * Before a hold, before the Redis gate and any database query: with the
   * waiting room on, only admitted accounts get through. Fail open.
   */
  async isAdmitted(performanceId: string, userId: string): Promise<boolean> {
    try {
      const info = await this.performances.admissionInfo(performanceId);
      // Unknown performance: let the hold's own checks answer (404).
      if (!info?.waitingRoomEnabled) return true;
      const pass = await this.redis.exists(
        WaitingRoomKey.passPrefix(performanceId) + userId,
      );
      return pass === 1;
    } catch (error) {
      this.logger.warn(
        `Waiting room check skipped (fail open): ${String(error)}`,
      );
      return true;
    }
  }

  /**
   * Worker, every WAITING_ROOM_TICK_MS (BullMQ job admit-batch, one at a
   * time): for every performance with people waiting, admit the next ones
   * if a sale phase is open, then tell the line where it stands.
   */
  async admitBatch(): Promise<AdmitResult[]> {
    const results: AdmitResult[] = [];
    const active = await this.redis.smembers(WaitingRoomKey.active);
    for (const performanceId of active) {
      const info = await this.performances.admissionInfo(performanceId);
      if (!info || info.status !== 'PUBLISHED' || !info.waitingRoomEnabled) {
        // Cancelled, deleted or switched off: nobody will be admitted (with
        // the room off nobody needs to be). The keys expire on their own.
        await this.redis.srem(WaitingRoomKey.active, performanceId);
        continue;
      }
      const result = await this.admit(performanceId, info);
      results.push(result);
    }
    return results;
  }

  private async admit(
    performanceId: string,
    info: AdmissionInfo,
  ): Promise<AdmitResult> {
    const passTtlMs = this.config.get('WAITING_ROOM_PASS_TTL_SECONDS') * 1000;
    // Before the sale opens nobody is admitted (a pass would run out before
    // it could be used), but the line still hears how long it has grown.
    const howMany = info.openPhase
      ? this.config.get('WAITING_ROOM_ADMIT_PER_TICK')
      : 0;
    const [admitted, admittedThrough, waiting] = (await admitScript.run(
      this.redis,
      [
        WaitingRoomKey.line(performanceId),
        WaitingRoomKey.meta(performanceId),
        WaitingRoomKey.active,
      ],
      [
        howMany,
        passTtlMs,
        performanceId,
        WaitingRoomKey.passPrefix(performanceId),
        LINE_KEY_TTL_SECONDS,
      ],
    )) as [string[], number, number];

    // The pass was set inside the script just now; this expiry is at most
    // a few milliseconds late, never early.
    const expiresAt = new Date(Date.now() + passTtlMs).toISOString();
    await Promise.all([
      this.publisher.emit(lineRoom(performanceId), QueueEvent.POSITION, {
        performanceId,
        admittedThrough,
        waiting,
      } satisfies QueuePositionEvent),
      ...admitted.map((userId) =>
        this.publisher.emit(
          personRoom(performanceId, userId),
          QueueEvent.ADMITTED,
          { performanceId, expiresAt } satisfies QueueAdmittedEvent,
        ),
      ),
    ]);
    return {
      performanceId,
      admitted: admitted.length,
      admittedThrough,
      waiting,
    };
  }

  private async run(
    performanceId: string,
    userId: string,
    join: boolean,
    info: AdmissionInfo,
  ): Promise<QueueStatusDto> {
    const [state, a, admittedThrough, waiting] = (await joinScript.run(
      this.redis,
      [
        WaitingRoomKey.line(performanceId),
        WaitingRoomKey.meta(performanceId),
        WaitingRoomKey.passPrefix(performanceId) + userId,
        WaitingRoomKey.active,
      ],
      [userId, performanceId, LINE_KEY_TTL_SECONDS, join ? '1' : '0'],
    )) as [string, number, number, number];
    if (state === QueueState.ADMITTED) {
      return {
        status: QueueState.ADMITTED,
        expiresAt: new Date(Date.now() + a),
      };
    }
    if (state === QueueState.WAITING) {
      const position = a - admittedThrough;
      const waitMs = estimateWaitMs(
        position,
        info.opensAt ? info.opensAt.getTime() - Date.now() : 0,
        this.config.get('WAITING_ROOM_ADMIT_PER_TICK'),
        this.config.get('WAITING_ROOM_TICK_MS'),
      );
      return {
        status: QueueState.WAITING,
        number: a,
        position,
        admittedThrough,
        waiting,
        estimatedWaitSeconds: Math.ceil(waitMs / 1000),
        pollAfterMs: pollAfterMs(waitMs),
      };
    }
    return { status: QueueState.NONE, admittedThrough, waiting };
  }

  /** The performance, as customers see it: drafts do not exist. */
  private async visible(performanceId: string): Promise<AdmissionInfo> {
    const info = await this.performances.admissionInfo(performanceId);
    if (!info || info.status === 'DRAFT') {
      throw new AppException(
        HttpStatus.NOT_FOUND,
        ErrorCode.PERFORMANCE_NOT_FOUND,
        'Performance not found',
      );
    }
    return info;
  }
}
