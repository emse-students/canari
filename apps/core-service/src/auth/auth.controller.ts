import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Head,
  HttpCode,
  NotFoundException,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as jwt from 'jsonwebtoken';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';

interface OidcCallbackDto {
  code: string;
  redirect_uri: string;
}

const REFRESH_COOKIE = 'canari_refresh';
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

function isEnvFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;

  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    default:
      return false;
  }
}

@Controller('auth')
export class AuthController {
  private readonly jwtSecret: string;
  private readonly authentikBaseUrl: string;
  private readonly authentikClientId: string;
  private readonly authentikClientSecret: string;
  private readonly devRoutesEnabled: boolean;
  private readonly isProduction: boolean;

  constructor(private readonly usersService: UsersService) {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret === 'change-me-in-production') {
      throw new Error(
        'JWT_SECRET must be set to a strong random value (e.g. openssl rand -hex 32)',
      );
    }
    this.jwtSecret = secret;
    this.isProduction = process.env.NODE_ENV === 'production';

    this.authentikBaseUrl = (process.env.AUTHENTIK_BASE_URL || '').replace(
      /\/+$/,
      '',
    );
    this.authentikClientId = process.env.AUTHENTIK_CLIENT_ID || '';
    this.authentikClientSecret = process.env.AUTHENTIK_CLIENT_SECRET || '';
    this.devRoutesEnabled = isEnvFlagEnabled(process.env.ENABLE_DEV_ROUTES);
  }

  /** Set the refresh token as an HttpOnly cookie. */
  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: 'lax',
      path: '/api/auth', // only sent to auth endpoints
      maxAge: REFRESH_MAX_AGE * 1000, // express uses milliseconds
    });
  }

  /** Clear the refresh cookie (e.g. on logout or expired session). */
  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: 'lax',
      path: '/api/auth',
    });
  }

  // ─── OIDC callback (Authentik) ─────────────────────────────────────────────
  // The frontend redirects the user to Authentik, which redirects back with a
  // `code`.  The frontend then POSTs that code here so we can exchange it for
  // tokens server-side (keeping the client_secret safe).

  // ─── TEMPORARY: bypass Authentik ────────────────────────────────────────────
  // Creates a dev user and returns tokens without touching Authentik.
  // TODO: remove this endpoint once Authentik is fully configured.
  @Post('dev-login')
  @HttpCode(200)
  async devLogin(
    @Body() body: { id?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<{
    access_token: string;
    user: {
      id: string;
      email: string;
      displayName: string;
      promo: number | null;
      firstName: string | null;
      lastName: string | null;
      bio: string | null;
      admin: boolean;
    };
  }> {
    if (!this.devRoutesEnabled) {
      throw new NotFoundException('Dev login is disabled');
    }

    const devId = (body?.id || 'dev').trim().toLowerCase();

    let user: User;
    try {
      // First try to find existing user with legacy 'dev-' prefix
      const legacyId = `dev-${devId}`;
      const existingLegacy = await this.usersService
        .findOne(legacyId)
        .catch(() => null);
      if (existingLegacy) {
        user = existingLegacy;
      } else {
        // Try new ID format, or create new user
        user = await this.usersService.findOrCreateFromOidc(
          devId,
          `${devId}@canari.local`,
          devId,
          devId,
          devId,
        );
      }
    } catch (err) {
      console.error('[dev-login] Failed to find/create user:', devId, err);
      throw new BadRequestException(
        `Failed to create user: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const access_token = jwt.sign(
      { sub: user.id, admin: !!user.admin },
      this.jwtSecret,
      {
        expiresIn: '1h',
      },
    );
    const refresh_token = jwt.sign(
      { sub: user.id, type: 'refresh' },
      this.jwtSecret,
      { expiresIn: '7d' },
    );

    this.setRefreshCookie(res, refresh_token);

    return {
      access_token,
      user: {
        id: user.id,
        email: user.email || '',
        displayName: user.displayName || '',
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        promo: user.promo ?? null,
        bio: user.bio ?? null,
        admin: !!user.admin,
      },
    };
  }
  @Post('oidc/callback')
  @HttpCode(200)
  async oidcCallback(
    @Body() body: OidcCallbackDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{
    access_token: string;
    user: {
      id: string;
      email: string;
      displayName: string;
      promo: number | null;
      firstName: string | null;
      lastName: string | null;
      bio: string | null;
      admin: boolean;
    };
  }> {
    const { code, redirect_uri } = body ?? {};
    if (!code) throw new BadRequestException('code is required');
    if (!redirect_uri)
      throw new BadRequestException('redirect_uri is required');

    if (
      !this.authentikBaseUrl ||
      !this.authentikClientId ||
      !this.authentikClientSecret
    ) {
      throw new BadRequestException(
        'Authentik OIDC is not configured on the server',
      );
    }

    // 1. Exchange authorization code for tokens
    const tokenUrl = `${this.authentikBaseUrl}/application/o/token/`;
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri,
        client_id: this.authentikClientId,
        client_secret: this.authentikClientSecret,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => '');
      throw new UnauthorizedException(
        `Authentik token exchange failed (${tokenRes.status}): ${errText}`,
      );
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      id_token?: string;
    };

    // 2. Fetch user info from Authentik
    const userinfoUrl = `${this.authentikBaseUrl}/application/o/userinfo/`;
    const userinfoRes = await fetch(userinfoUrl, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userinfoRes.ok) {
      throw new UnauthorizedException(
        'Failed to fetch user info from Authentik',
      );
    }

    const userinfo = (await userinfoRes.json()) as {
      sub: string;
      email?: string;
      name?: string;
      promo?: number;
      firstName?: string;
      lastName?: string;
    };

    console.log('[oidcCallback] userinfo from Authentik:', userinfo);

    if (!userinfo.sub) {
      throw new UnauthorizedException(
        'Invalid userinfo response from Authentik',
      );
    }

    // 3. Upsert local user
    const promo = typeof userinfo.promo === 'number' ? userinfo.promo : null;
    const user = await this.usersService.findOrCreateFromOidc(
      userinfo.sub,
      userinfo.email || null,
      userinfo.name || null,
      userinfo.firstName || null,
      userinfo.lastName || null,
      promo,
    );

    // 4. Issue internal JWT pair
    const access_token = jwt.sign(
      { sub: user.id, admin: !!user.admin },
      this.jwtSecret,
      {
        expiresIn: '1h',
      },
    );
    const refresh_token = jwt.sign(
      { sub: user.id, type: 'refresh' },
      this.jwtSecret,
      { expiresIn: '7d' },
    );

    // Set refresh token as HttpOnly cookie (not accessible to JS)
    this.setRefreshCookie(res, refresh_token);

    return {
      access_token,
      user: {
        id: user.id,
        email: user.email || '',
        displayName: user.displayName || '',
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        promo: user.promo ?? null,
        bio: user.bio ?? null,
        admin: !!user.admin,
      },
    };
  }

  // ─── Token refresh ─────────────────────────────────────────────────────────
  @Post('refresh')
  @HttpCode(200)
  async refreshToken(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ access_token: string }> {
    const refresh_token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!refresh_token) {
      this.clearRefreshCookie(res);
      throw new UnauthorizedException('No refresh token — please log in again');
    }

    let payload: { sub: string; type: string };
    try {
      payload = jwt.verify(refresh_token, this.jwtSecret) as {
        sub: string;
        type: string;
      };
    } catch {
      this.clearRefreshCookie(res);
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    if (payload.type !== 'refresh') {
      this.clearRefreshCookie(res);
      throw new UnauthorizedException('Invalid token type');
    }

    // Look up the user to get current admin status
    const user = await this.usersService.findOne(payload.sub).catch(() => null);
    const isAdmin = !!user?.admin;

    const access_token = jwt.sign(
      { sub: payload.sub, admin: isAdmin },
      this.jwtSecret,
      {
        expiresIn: '1h',
      },
    );
    const new_refresh = jwt.sign(
      { sub: payload.sub, type: 'refresh' },
      this.jwtSecret,
      { expiresIn: '7d' },
    );

    // Rotate the refresh cookie
    this.setRefreshCookie(res, new_refresh);

    return { access_token };
  }

  // ─── Logout ────────────────────────────────────────────────────────────────
  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response): { ok: true } {
    this.clearRefreshCookie(res);
    return { ok: true };
  }

  // ─── Verify (used by nginx auth_request) ──────────────────────────────────
  @Get('verify')
  verifyStart(@Req() req: Request, @Res() res: Response) {
    this.check(req, res);
  }

  @Head('verify')
  verify(@Req() req: Request, @Res() res: Response) {
    this.check(req, res);
  }

  private check(req: Request, res: Response) {
    const rawHeaders = req.headers['authorization'];

    // Default: not authenticated — headers are always set so downstream services
    // receive a consistent shape regardless of whether a token was provided.
    res.set('X-User-Id', '');
    res.set('X-Logged-In', 'false');
    res.set('X-Global-Admin', 'false');

    if (!rawHeaders) {
      return res.status(200).send();
    }

    const parts = String(rawHeaders).split(' ');
    const token = parts.length > 1 ? parts[1] : parts[0];
    if (!token) {
      return res.status(200).send();
    }

    try {
      const payload = jwt.verify(token, this.jwtSecret) as {
        sub: string;
        admin?: boolean;
      };

      res.set('X-User-Id', payload.sub);
      res.set('X-Logged-In', 'true');
      res.set('X-Global-Admin', payload.admin ? 'true' : 'false');
      return res.status(200).send();
    } catch {
      // Invalid/expired token — pass through as anonymous; the service decides
      // whether to reject the request.
      return res.status(200).send();
    }
  }
}
