import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { WsException } from '@nestjs/websockets';
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
  /** Present (true) only for the read-only demo account. */
  demo?: true;
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
    // HTTP: "Authorization: Bearer <token>". WebSocket (Socket.IO): the
    // client sends the token in the handshake (`auth: { token }`), and the
    // user is kept on socket.data for the connection's lifetime.
    const ws = context.getType() === 'ws';
    const holder: { user?: AuthUser } = ws
      ? (context.switchToWs().getClient<WsClient>().data ??= {})
      : context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = ws
      ? wsToken(context.switchToWs().getClient<WsClient>())
      : extractBearerToken(
          context.switchToHttp().getRequest<AuthenticatedRequest>().headers
            .authorization,
        );

    if (token) {
      const user = await this.verify(token);
      if (user) {
        holder.user = user;
        return true;
      }
    }
    if (isPublic) {
      return true;
    }
    if (ws) {
      throw new WsException('Missing or invalid access token');
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
      return {
        id: payload.sub,
        role: payload.role,
        ...(payload.demo ? { demo: true } : {}),
      };
    } catch {
      return null;
    }
  }
}

/** The parts of a Socket.IO socket the guards use. */
export interface WsClient {
  handshake?: { auth?: Record<string, unknown> };
  data?: { user?: AuthUser };
}

function wsToken(client: WsClient): string | null {
  const token = client.handshake?.auth?.token;
  return typeof token === 'string' && token !== '' ? token : null;
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}
