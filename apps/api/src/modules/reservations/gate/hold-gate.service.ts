import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppException } from '../../../common/errors/app.exception.js';
import { ErrorCode } from '../../../common/errors/error-codes.js';
import { AppConfigService } from '../../../config/app-config.service.js';
import { REDIS } from '../../../redis/redis.module.js';
import { ZonesService } from '../../concerts/zones.service.js';
import type { StandingSelection } from '../reservation-request.js';
import {
  commitScript,
  holdScript,
  reconcileScript,
  releaseScript,
  rollbackScript,
} from './gate.scripts.js';

const seatKey = (seatId: string) => `seat:hold:${seatId}`;
const availKey = (zoneId: string) => `zone:avail:${zoneId}`;
const inflightKey = (zoneId: string) => `zone:inflight:${zoneId}`;
const requestKey = (owner: string) => `hold:req:${owner}`;

// An in-flight hold either commits or rolls back within one database
// transaction (max wait + timeout). Markers older than this belong to a
// process that crashed in between.
const STALE_INFLIGHT_MS = 60_000;

export interface GateTicket {
  /** True when this call changed Redis and must later commit or roll back. */
  applied: boolean;
  owner: string;
  seatIds: string[];
  standing: StandingSelection[];
}

export interface ReconcileReport {
  zones: number;
  corrected: { zoneId: string; from: string; to: number }[];
  busy: number;
}

/**
 * Redis filter in front of PostgreSQL (flow A, step 3).
 *
 * It rejects requests that are certain to fail (seat already held, zone sold
 * out) in about a millisecond, before they take a database connection. It is
 * NOT the source of truth: when Redis is down, empty or out of date, requests
 * go through to PostgreSQL, whose guards (ADR-0008) decide. Every way Redis
 * can drift is designed to err on the side of letting a request through.
 */
@Injectable()
export class HoldGateService {
  private readonly logger = new Logger(HoldGateService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: AppConfigService,
    private readonly zones: ZonesService,
  ) {}

  get enabled(): boolean {
    return this.config.get('RESERVATION_GATE_ENABLED');
  }

  /** Short TTL while the database transaction runs; frees itself after a crash. */
  private get pendingTtlMs(): number {
    return (
      this.config.get('DB_TX_MAX_WAIT_MS') +
      this.config.get('DB_TX_TIMEOUT_MS') +
      5_000
    );
  }

  /** Outlives the database hold slightly; the expiry job deletes keys sooner. */
  private get fullTtlMs(): number {
    return (
      (this.config.get('HOLD_TTL_SECONDS') +
        this.config.get('PAYMENT_GRACE_SECONDS') +
        60) *
      1000
    );
  }

  /**
   * Takes the seats and standing tickets in Redis, or throws 409 if Redis
   * already knows they are gone. Any Redis failure lets the request through.
   */
  async acquire(
    owner: string,
    seatIds: string[],
    standing: StandingSelection[],
  ): Promise<GateTicket> {
    const ticket: GateTicket = { applied: false, owner, seatIds, standing };
    if (!this.enabled) return ticket;

    try {
      let result = await this.runHold(owner, seatIds, standing);
      if (result[0] === 'MISSING') {
        await this.initCounters(standing.map((s) => s.zoneId));
        result = await this.runHold(owner, seatIds, standing);
      }
      switch (result[0]) {
        case 'OK':
          return { ...ticket, applied: true };
        case 'SEATS_TAKEN':
          throw new AppException(
            HttpStatus.CONFLICT,
            ErrorCode.SEAT_UNAVAILABLE,
            'Some seats are no longer available',
            {
              seatIds: result.slice(1).map((k) => k.replace('seat:hold:', '')),
            },
          );
        case 'SOLD_OUT': {
          // Same body as the database's SOLD_OUT, so clients see no difference.
          const zoneId = (result[1] ?? '').replace('zone:avail:', '');
          throw new AppException(
            HttpStatus.CONFLICT,
            ErrorCode.SOLD_OUT,
            'Not enough standing tickets left in this zone',
            {
              zoneId,
              requested: standing.find((s) => s.zoneId === zoneId)?.quantity,
              available: Math.max(Number(result[2] ?? 0), 0),
            },
          );
        }
        default:
          // DUPLICATE (the same owner is already in flight: the database's
          // idempotency check will answer) or still MISSING.
          return ticket;
      }
    } catch (error) {
      if (error instanceof AppException) throw error;
      this.logger.warn(
        `Gate unavailable, falling back to the database: ${String(error)}`,
      );
      return ticket;
    }
  }

  /** The database committed the hold. */
  async commit(ticket: GateTicket): Promise<void> {
    if (!ticket.applied) return;
    await this.safely(() =>
      commitScript.run(
        this.redis,
        [
          requestKey(ticket.owner),
          ...ticket.seatIds.map(seatKey),
          ...ticket.standing.map((s) => inflightKey(s.zoneId)),
        ],
        [
          ticket.owner,
          this.fullTtlMs,
          ticket.seatIds.length,
          ticket.standing.length,
        ],
      ),
    );
  }

  /** The database refused or failed: undo what acquire() did. */
  async rollback(ticket: GateTicket): Promise<void> {
    if (!ticket.applied) return;
    await this.safely(() =>
      rollbackScript.run(
        this.redis,
        [
          requestKey(ticket.owner),
          ...ticket.seatIds.map(seatKey),
          ...ticket.standing.map((s) => availKey(s.zoneId)),
          ...ticket.standing.map((s) => inflightKey(s.zoneId)),
        ],
        [
          ticket.owner,
          ticket.seatIds.length,
          ticket.standing.length,
          ...ticket.standing.map((s) => s.quantity),
        ],
      ),
    );
  }

  /** An order was released in the database: free its seats and tickets. */
  async release(
    seatIds: string[],
    standing: StandingSelection[],
  ): Promise<void> {
    if (!this.enabled || (seatIds.length === 0 && standing.length === 0))
      return;
    await this.safely(() =>
      releaseScript.run(
        this.redis,
        [...seatIds.map(seatKey), ...standing.map((s) => availKey(s.zoneId))],
        [seatIds.length, standing.length, ...standing.map((s) => s.quantity)],
      ),
    );
  }

  /**
   * Repairs standing counters from PostgreSQL. A counter can drift when a
   * process crashes between the Redis hold and its commit or rollback.
   */
  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = { zones: 0, corrected: [], busy: 0 };
    if (!this.enabled) return report;
    const ids = await this.zones.standingZoneIds();
    const truth = await this.zones.standingAvailability(ids);
    for (const [zoneId, value] of truth) {
      const exists = await this.redis.exists(availKey(zoneId));
      if (!exists) continue; // created lazily on first use
      report.zones += 1;
      const result = (await reconcileScript.run(
        this.redis,
        [availKey(zoneId), inflightKey(zoneId)],
        [value, Date.now(), STALE_INFLIGHT_MS],
      )) as string[];
      if (result[0] === 'SET') {
        report.corrected.push({ zoneId, from: result[1] ?? 'none', to: value });
      } else if (result[0] === 'BUSY') {
        report.busy += 1;
      }
    }
    if (report.corrected.length > 0) {
      this.logger.warn(
        `Reconciled standing counters: ${JSON.stringify(report.corrected)}`,
      );
    }
    return report;
  }

  private async runHold(
    owner: string,
    seatIds: string[],
    standing: StandingSelection[],
  ): Promise<string[]> {
    return (await holdScript.run(
      this.redis,
      [
        requestKey(owner),
        ...seatIds.map(seatKey),
        ...standing.map((s) => availKey(s.zoneId)),
        ...standing.map((s) => inflightKey(s.zoneId)),
      ],
      [
        owner,
        this.pendingTtlMs,
        seatIds.length,
        standing.length,
        Date.now(),
        ...standing.map((s) => s.quantity),
      ],
    )) as string[];
  }

  /** Creates missing counters from PostgreSQL (SET NX: never overwrite). */
  private async initCounters(zoneIds: string[]): Promise<void> {
    const truth = await this.zones.standingAvailability(zoneIds);
    for (const [zoneId, value] of truth) {
      await this.redis.set(availKey(zoneId), value, 'NX');
    }
  }

  private async safely(op: () => Promise<unknown>): Promise<void> {
    try {
      await op();
    } catch (error) {
      // A missed commit/rollback/release leaves keys that expire on their own
      // (seats) or are repaired by reconcile() (standing counters).
      this.logger.warn(`Gate update failed: ${String(error)}`);
    }
  }
}
