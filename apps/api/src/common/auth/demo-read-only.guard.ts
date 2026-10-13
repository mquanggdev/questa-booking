import {
  HttpStatus,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '../errors/app.exception.js';
import { ErrorCode } from '../errors/error-codes.js';
import { IS_PUBLIC_KEY, type AuthenticatedRequest } from './auth.decorators.js';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The online demo's public organizer account (users.is_demo) sees every
 * organizer page but changes nothing: any non-read request from it is
 * refused (phase 9). Public routes (login, refresh, logout) stay open, so
 * the account can still sign in and out. Runs after JwtAuthGuard.
 */
@Injectable()
export class DemoReadOnlyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true; // sockets only read
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user?.demo || READS.has(request.method)) return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    throw new AppException(
      HttpStatus.FORBIDDEN,
      ErrorCode.DEMO_READ_ONLY,
      'This is the read-only demo account: it can look, not change',
    );
  }
}
