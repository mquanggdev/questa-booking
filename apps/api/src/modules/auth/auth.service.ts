import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import type { AccessTokenPayload } from '../../common/auth/jwt-auth.guard.js';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { Prisma, type User } from '../../generated/prisma/client.js';
import {
  toPublicUser,
  UsersService,
  type PublicUser,
} from '../users/users.service.js';
import type { LoginDto, RegisterDto } from './dto/auth.dto.js';
import {
  RefreshTokenService,
  type IssuedRefreshToken,
} from './refresh-token.service.js';

export interface Session {
  accessToken: string;
  expiresIn: number;
  user: PublicUser;
  refresh: IssuedRefreshToken;
}

@Injectable()
export class AuthService {
  // Verified when the email does not exist, so a wrong email and a wrong
  // password take the same time (no account enumeration through timing).
  private readonly dummyHash = argon2.hash('dummy-password-for-timing');

  constructor(
    private readonly users: UsersService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<PublicUser> {
    const passwordHash = await argon2.hash(dto.password);
    try {
      const user = await this.users.create({
        email: dto.email,
        passwordHash,
        fullName: dto.fullName,
      });
      return toPublicUser(user);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new AppException(
          HttpStatus.CONFLICT,
          ErrorCode.EMAIL_TAKEN,
          'An account with this email already exists',
        );
      }
      throw error;
    }
  }

  async login(dto: LoginDto): Promise<Session> {
    const user = await this.users.findByEmail(dto.email);
    const valid = await argon2.verify(
      user?.passwordHash ?? (await this.dummyHash),
      dto.password,
    );
    if (!user || !valid) {
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.INVALID_CREDENTIALS,
        'Email or password is incorrect',
      );
    }
    return this.createSession(user, await this.refreshTokens.issue(user.id));
  }

  async refresh(refreshToken: string): Promise<Session> {
    const rotated = await this.refreshTokens.rotate(refreshToken);
    const user = await this.users.findById(rotated.userId);
    if (!user) {
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.INVALID_REFRESH_TOKEN,
        'Refresh token is invalid or expired',
      );
    }
    return this.createSession(user, rotated);
  }

  logout(refreshToken: string): Promise<void> {
    return this.refreshTokens.revoke(refreshToken);
  }

  private async createSession(
    user: User,
    refresh: IssuedRefreshToken,
  ): Promise<Session> {
    const payload: AccessTokenPayload = { sub: user.id, role: user.role };
    const expiresIn = this.config.get('JWT_ACCESS_TTL_SECONDS');
    const accessToken = await this.jwt.signAsync(payload, { expiresIn });
    return { accessToken, expiresIn, user: toPublicUser(user), refresh };
  }
}
