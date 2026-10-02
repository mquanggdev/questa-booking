import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
}

export interface RotatedRefreshToken extends IssuedRefreshToken {
  userId: string;
}

// A refresh token has 256 random bits, so a fast SHA-256 is enough to store
// it safely; slow hashes (argon2) only matter for low-entropy passwords.
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  /** Starts a new token family (one per login). */
  issue(userId: string): Promise<IssuedRefreshToken> {
    return this.insert(userId, randomUUID());
  }

  /**
   * Single-use rotation: the presented token is revoked and a new token in the
   * same family is returned. Presenting an already revoked token means it was
   * copied or replayed, so the whole family is revoked (reuse detection).
   */
  async rotate(token: string): Promise<RotatedRefreshToken> {
    const tokenHash = hashToken(token);

    const rotated = await this.prisma.$transaction(async (tx) => {
      // Conditional UPDATE is the lock: of two concurrent refreshes with the
      // same token, exactly one matches "revoked_at IS NULL".
      const rows = await tx.$queryRaw<
        { id: string; user_id: string; family_id: string }[]
      >`
        UPDATE refresh_tokens
        SET revoked_at = now()
        WHERE token_hash = ${tokenHash}
          AND revoked_at IS NULL
          AND expires_at > now()
        RETURNING id, user_id, family_id
      `;
      const current = rows[0];
      if (!current) {
        return null;
      }
      const next = await this.insert(current.user_id, current.family_id, tx);
      await tx.refreshToken.update({
        where: { id: current.id },
        data: { replacedBy: next.id },
      });
      return {
        userId: current.user_id,
        token: next.token,
        expiresAt: next.expiresAt,
      };
    });

    if (rotated) {
      return rotated;
    }

    // Outside the transaction on purpose: the family revocation must commit
    // even though the request fails.
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      select: { familyId: true, revokedAt: true },
    });
    if (existing?.revokedAt) {
      await this.revokeFamily(existing.familyId);
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.REFRESH_TOKEN_REUSED,
        'Refresh token was already used; all sessions from this login were revoked',
      );
    }
    throw new AppException(
      HttpStatus.UNAUTHORIZED,
      ErrorCode.INVALID_REFRESH_TOKEN,
      'Refresh token is invalid or expired',
    );
  }

  /** Logout: revokes the token's whole family. Unknown tokens are ignored. */
  async revoke(token: string): Promise<void> {
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { familyId: true },
    });
    if (existing) {
      await this.revokeFamily(existing.familyId);
    }
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async insert(
    userId: string,
    familyId: string,
    tx: Pick<PrismaService, 'refreshToken'> = this.prisma,
  ): Promise<IssuedRefreshToken & { id: string }> {
    const token = randomBytes(32).toString('base64url');
    const ttlDays = this.config.get('REFRESH_TOKEN_TTL_DAYS');
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    const row = await tx.refreshToken.create({
      data: { userId, familyId, tokenHash: hashToken(token), expiresAt },
      select: { id: true },
    });
    return { id: row.id, token, expiresAt };
  }
}
