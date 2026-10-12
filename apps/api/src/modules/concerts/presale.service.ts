import { HttpStatus, Injectable } from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth.decorators.js';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { isPgError, PgCode } from '../../common/errors/pg-error.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ConcertsService } from './concerts.service.js';
import type {
  GeneratePresaleCodesDto,
  PresaleCodeDto,
  PresaleCodesResponseDto,
  PresaleRedemptionDto,
} from './dto/presale.dto.js';
import { formatPresaleCode, newPresaleCode } from './presale-code.js';

/**
 * Presale codes (I11). The organizer generates single-use codes for a
 * PRESALE phase and hands them out (fan club, partners). A customer redeems
 * one; during that phase only accounts that redeemed a code may hold tickets
 * (checked by PerformancesService.getOnSale).
 */
@Injectable()
export class PresaleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly concerts: ConcertsService,
  ) {}

  async generate(
    performanceId: string,
    organizer: AuthUser,
    dto: GeneratePresaleCodesDto,
  ): Promise<PresaleCodesResponseDto> {
    await this.assertOwner(performanceId, organizer);
    const phase = await this.prisma.salePhase.findFirst({
      where: { id: dto.salePhaseId, performanceId },
      select: { type: true, endsAt: true },
    });
    if (!phase || phase.type !== 'PRESALE') {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        [
          {
            field: 'salePhaseId',
            errors: ['must be a PRESALE phase of this performance'],
          },
        ],
      );
    }
    if (phase.endsAt <= new Date()) {
      throw presaleClosed();
    }

    // A collision in a space of 30^10 codes is very unlikely but possible:
    // skipDuplicates drops it and the loop makes up the difference.
    const codes: string[] = [];
    while (codes.length < dto.count) {
      const batch = Array.from({ length: dto.count - codes.length }, () =>
        newPresaleCode(),
      );
      const created = await this.prisma.presaleCode.createManyAndReturn({
        data: batch.map((code) => ({ salePhaseId: dto.salePhaseId, code })),
        skipDuplicates: true,
        select: { code: true },
      });
      codes.push(...created.map((c) => c.code));
    }
    return {
      salePhaseId: dto.salePhaseId,
      codes: codes.map(formatPresaleCode),
    };
  }

  async list(
    performanceId: string,
    organizer: AuthUser,
  ): Promise<PresaleCodeDto[]> {
    await this.assertOwner(performanceId, organizer);
    const codes = await this.prisma.presaleCode.findMany({
      where: { salePhase: { performanceId } },
      select: { code: true, salePhaseId: true, redeemedAt: true },
      orderBy: { id: 'asc' },
    });
    return codes.map((c) => ({ ...c, code: formatPresaleCode(c.code) }));
  }

  /** `code` is already normalized (RedeemPresaleCodeDto). */
  async redeem(
    performanceId: string,
    userId: string,
    code: string,
  ): Promise<PresaleRedemptionDto> {
    const performance = await this.prisma.performance.findUnique({
      where: { id: performanceId },
      select: { status: true },
    });
    if (!performance || performance.status === 'DRAFT') {
      throw invalidCode();
    }
    if (performance.status === 'CANCELLED') {
      throw presaleClosed();
    }

    let rows: { sale_phase_id: string; redeemed_at: Date }[];
    try {
      // I11: a code is used at most once. Of two concurrent redemptions of
      // the same code, exactly one finds redeemed_by IS NULL; the other
      // updates nothing. The code must belong to a phase of this
      // performance that is not over yet.
      rows = await this.prisma.$queryRaw`
        UPDATE presale_codes pc
        SET redeemed_by = ${userId}::uuid, redeemed_at = now()
        FROM sale_phases sp
        WHERE pc.code = ${code}
          AND pc.redeemed_by IS NULL
          AND sp.id = pc.sale_phase_id
          AND sp.performance_id = ${performanceId}::uuid
          AND sp.ends_at > now()
        RETURNING pc.sale_phase_id, pc.redeemed_at
      `;
    } catch (error) {
      // The partial unique index (sale_phase_id, redeemed_by): this account
      // already redeemed another code of the phase. Nothing was changed, so
      // the second code stays free for someone else.
      if (
        isPgError(
          error,
          PgCode.UNIQUE_VIOLATION,
          'presale_codes_sale_phase_id_redeemed_by_key',
        )
      ) {
        throw new AppException(
          HttpStatus.CONFLICT,
          ErrorCode.PRESALE_ALREADY_REDEEMED,
          'This account already redeemed a code for this presale',
        );
      }
      throw error;
    }
    const redeemed = rows[0];
    if (redeemed) {
      return {
        salePhaseId: redeemed.sale_phase_id,
        redeemedAt: redeemed.redeemed_at,
      };
    }
    return this.explainNotRedeemed(performanceId, userId, code);
  }

  /** Has this account redeemed a code of this sale phase? */
  async hasRedeemed(salePhaseId: string, userId: string): Promise<boolean> {
    const found = await this.prisma.presaleCode.findFirst({
      where: { salePhaseId, redeemedBy: userId },
      select: { id: true },
    });
    return found !== null;
  }

  /** Sale phases of this performance the account redeemed a code for. */
  async redemptionsOf(
    performanceId: string,
    userId: string,
  ): Promise<PresaleRedemptionDto[]> {
    const codes = await this.prisma.presaleCode.findMany({
      where: { redeemedBy: userId, salePhase: { performanceId } },
      select: { salePhaseId: true, redeemedAt: true },
    });
    return codes.map((c) => ({
      salePhaseId: c.salePhaseId,
      redeemedAt: c.redeemedAt!,
    }));
  }

  /**
   * The UPDATE matched nothing: read the code to answer precisely. Redeeming
   * your own code again is not an error (a retry after a lost response).
   */
  private async explainNotRedeemed(
    performanceId: string,
    userId: string,
    code: string,
  ): Promise<PresaleRedemptionDto> {
    const found = await this.prisma.presaleCode.findUnique({
      where: { code },
      select: {
        salePhaseId: true,
        redeemedBy: true,
        redeemedAt: true,
        salePhase: { select: { performanceId: true, endsAt: true } },
      },
    });
    // A code of another performance is reported as unknown: the answer must
    // not reveal that the code exists elsewhere.
    if (!found || found.salePhase.performanceId !== performanceId) {
      throw invalidCode();
    }
    if (found.redeemedBy === userId) {
      return { salePhaseId: found.salePhaseId, redeemedAt: found.redeemedAt! };
    }
    if (found.redeemedBy !== null) {
      throw new AppException(
        HttpStatus.CONFLICT,
        ErrorCode.PRESALE_CODE_USED,
        'This code was already used',
      );
    }
    // Free, but the UPDATE did not match: the phase is over.
    throw presaleClosed();
  }

  private async assertOwner(id: string, organizer: AuthUser): Promise<void> {
    const performance = await this.prisma.performance.findUnique({
      where: { id },
      select: { concertId: true },
    });
    if (!performance) {
      throw new AppException(
        HttpStatus.NOT_FOUND,
        ErrorCode.PERFORMANCE_NOT_FOUND,
        'Performance not found',
      );
    }
    await this.concerts.assertOwner(performance.concertId, organizer);
  }
}

function invalidCode(): AppException {
  return new AppException(
    HttpStatus.NOT_FOUND,
    ErrorCode.PRESALE_CODE_INVALID,
    'Unknown presale code for this performance',
  );
}

function presaleClosed(): AppException {
  return new AppException(
    HttpStatus.CONFLICT,
    ErrorCode.PRESALE_CLOSED,
    'This presale is over',
  );
}
