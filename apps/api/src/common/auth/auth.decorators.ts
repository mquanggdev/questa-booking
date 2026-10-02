import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Role } from '../../generated/prisma/client.js';

export interface AuthUser {
  id: string;
  role: Role;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';

// Every route requires a valid access token unless marked @Public().
// On a public route a valid token is still read, so handlers can tailor
// the response (for example, an organizer sees their own drafts).
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().user,
);
