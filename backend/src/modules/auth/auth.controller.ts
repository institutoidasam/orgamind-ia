import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RefreshService } from './refresh.service';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { Public } from './decorators/public.decorator';
import { InvalidCredentialsError } from './errors/auth.errors';
import { Roles } from './decorators/roles.decorator';
import type { JwtPayload } from './jwt.strategy';

const REFRESH_COOKIE_NAME = 'picoa_refresh';
function setRefreshCookie(
  res: Response,
  refreshToken: string,
  maxAgeMs: number,
): void {
  const isProd = process.env.NODE_ENV === 'production';
  // Defensive: expire any legacy `path=/auth` cookie BEFORE setting the new
  // one. Without this, returning users who logged in before the path fix end
  // up with two cookies — `picoa_refresh; Path=/auth` (old) and
  // `picoa_refresh; Path=/` (new). cookie-parser only sees the first one in
  // the Cookie header, which is the legacy value whose token-family signature
  // no longer validates, so /auth/refresh fails 401 and F5 looks like logout.
  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/auth' });
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: isProd,
    // Strict in prod (TLS-fronted by Caddy); Lax in dev so cross-origin
    // localhost (vite:5173 -> api:3000) still works.
    sameSite: isProd ? 'strict' : 'lax',
    maxAge: maxAgeMs,
    // path '/' (not '/auth') because in production the SPA reaches the API
    // through nginx's `/api/*` rewrite — i.e. the browser sees the request
    // path as `/api/auth/refresh`, not `/auth/refresh`. A `path=/auth` cookie
    // never matches, so the browser silently drops it and F5 looks like a
    // logout. HttpOnly + Secure + SameSite=Strict provide real security; the
    // path restriction was only a size optimization.
    path: '/',
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/' });
  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/auth' });
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly refresh: RefreshService,
  ) {}

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Login with email/password (returns access token + sets refresh cookie)',
  })
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken, mustChangePassword, user } =
      await this.auth.login(dto);
    setRefreshCookie(res, refreshToken, this.refresh.refreshCookieMaxAgeMs());
    return { accessToken, mustChangePassword, user };
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate refresh token (cookie) and issue a new access token',
  })
  @Post('refresh')
  async refreshToken(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] as
      string | undefined;
    if (!refreshToken) {
      throw new InvalidCredentialsError();
    }
    const {
      accessToken,
      refreshToken: newRefresh,
      refreshTokenMaxAgeMs,
    } = await this.refresh.rotate(refreshToken);
    setRefreshCookie(res, newRefresh, refreshTokenMaxAgeMs);
    return { accessToken };
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke refresh token family and clear the cookie' })
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] as
      string | undefined;
    if (refreshToken) {
      await this.refresh.revoke(refreshToken);
    }
    clearRefreshCookie(res);
    return { ok: true };
  }

  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Roles('ADMIN', 'OPERATOR', 'SUPERVISOR', 'VIEWER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change current user password (throttled 5/min)' })
  @Post('change-password')
  async changePassword(
    @Req() req: Request & { user: JwtPayload },
    @Body() dto: ChangePasswordDto,
  ) {
    await this.auth.changePassword(req.user.sub, dto);
  }
}
