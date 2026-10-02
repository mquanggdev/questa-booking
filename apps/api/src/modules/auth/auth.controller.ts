import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import { Public } from '../../common/auth/auth.decorators.js';
import { AppException } from '../../common/errors/app.exception.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { UserResponseDto } from '../users/dto/user-response.dto.js';
import { AuthService, type Session } from './auth.service.js';
import { AuthResponseDto, LoginDto, RegisterDto } from './dto/auth.dto.js';

export const REFRESH_COOKIE = 'refresh_token';
// The browser sends the refresh cookie only to the auth endpoints.
const REFRESH_COOKIE_PATH = '/api/v1/auth';

@ApiTags('auth')
@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
  ) {}

  /** Create a customer account */
  @Post('register')
  register(@Body() dto: RegisterDto): Promise<UserResponseDto> {
    return this.auth.register(dto);
  }

  /**
   * Returns an access token in the body and sets the refresh token as an
   * httpOnly cookie, which page scripts cannot read (XSS cannot steal it).
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    return this.respond(res, await this.auth.login(dto));
  }

  /** Exchanges the refresh cookie for a new access token and a new cookie */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth(REFRESH_COOKIE)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const token = readRefreshCookie(req);
    if (!token) {
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.INVALID_REFRESH_TOKEN,
        'Refresh token cookie is missing',
      );
    }
    try {
      return this.respond(res, await this.auth.refresh(token));
    } catch (error) {
      res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
      throw error;
    }
  }

  /** Revokes the refresh token (and its rotation family) and clears the cookie */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth(REFRESH_COOKIE)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = readRefreshCookie(req);
    if (token) {
      await this.auth.logout(token);
    }
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
  }

  private respond(res: Response, session: Session): AuthResponseDto {
    res.cookie(REFRESH_COOKIE, session.refresh.token, {
      ...this.cookieOptions(),
      expires: session.refresh.expiresAt,
    });
    return {
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      user: session.user,
    };
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.get('COOKIE_SECURE'),
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
    };
  }
}

function readRefreshCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
