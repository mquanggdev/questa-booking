import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import type { Response } from 'express';

/**
 * Rate limiting (phase 7a). Registered after the auth guards, so the "user"
 * throttler can key on the signed-in user. Limits, Redis storage and when to
 * skip are configured in app.module.ts.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  /** Also send the standard Retry-After (named throttlers add a suffix). */
  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    context
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Retry-After', String(detail.timeToBlockExpire));
    return super.throwThrottlingException(context, detail);
  }
}
