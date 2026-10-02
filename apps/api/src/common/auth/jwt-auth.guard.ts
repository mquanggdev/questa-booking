import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role } from '../../generated/prisma/client.js';
import { AppException } from '../errors/app.exception.js';
import { ErrorCode } from '../errors/error-codes.js';
import {
  IS_PUBLIC_KEY,
  type AuthenticatedRequest,
  type AuthUser,
} from './auth.decorators.js';

export interface AccessTokenPayload {
  sub: string;
  role: Role;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.headers.authorization);

    if (token) {
      const user = await this.verify(token);
      if (user) {
        request.user = user;
        return true;
      }
    }
    if (isPublic) {
      return true;
    }
    throw new AppException(
      HttpStatus.UNAUTHORIZED,
      ErrorCode.UNAUTHORIZED,
      'Missing or invalid access token',
    );
  }

  private async verify(token: string): Promise<AuthUser | null> {
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
      if (!Object.values(Role).includes(payload.role)) {
        return null;
      }
      return { id: payload.sub, role: payload.role };
    } catch {
      return null;
    }
  }
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}
