import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Head,
  HttpCode,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as jwt from 'jsonwebtoken';
import { createHmac } from 'crypto';
import { UsersService } from '../users/users.service';
import { PlatformService } from '../platform/platform.service';

interface OidcCallbackDto {
  code: string;
  redirect_uri: string;
}

const REFRESH_COOKIE = 'canari_refresh';
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

/** Controller handling OIDC login, token refresh, logout, and nginx JWT verification. */
@Controller('auth')
export class AuthController {
  private readonly jwtSecret: string;
  private readonly authentikBaseUrl: string;
  private readonly authentikClientId: string;
  private readonly authentikClientSecret: string;
  private readonly isProduction: boolean;
  /** Shared secret used to sign X-Internal-Token HMAC headers for inter-service auth. */
  private readonly internalSecret: string;

  constructor(
    private readonly usersService: UsersService,
    private readonly platformService: PlatformService
  ) {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret === 'change-me-in-production') {
      throw new Error(
        'JWT_SECRET must be set to a strong random value (e.g. openssl rand -hex 32)'
      );
    }
    this.jwtSecret = secret;
    this.isProduction = process.env.NODE_ENV === 'production';

    this.authentikBaseUrl = (process.env.AUTHENTIK_BASE_URL || '').replace(/\/+$/, '');
    this.authentikClientId = process.env.AUTHENTIK_CLIENT_ID || '';
    this.authentikClientSecret = process.env.AUTHENTIK_CLIENT_SECRET || '';
    this.internalSecret = process.env.INTERNAL_SHARED_SECRET?.trim() ?? '';
  }

  private isDevEnvironment(req: Request): boolean {
    // In production, secure cookies (SameSite=none, Secure=true) are required because the
    // mobile app (tauri.localhost) makes cross-origin requests to the server.
    if (this.isProduction) {
      return false;
    }

    const origin = req.get('origin') || req.get('referer') || '';
    return (
      origin.includes('localhost') ||
      origin.includes('127.0.0.1') ||
      origin.includes('tauri.localhost')
    );
  }

  /** Set the refresh token as an HttpOnly cookie with environment-aware security settings. */
  private setRefreshCookie(req: Request, res: Response, token: string): void {
    const isDev = this.isDevEnvironment(req);

    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: isDev ? false : true, // dev: HTTP allowed; prod: HTTPS required
      sameSite: isDev ? 'lax' : 'none', // dev: lax (avoid cross-origin blocking); prod: none (cross-origin)
      path: '/api/auth',
      maxAge: REFRESH_MAX_AGE * 1000, // express uses milliseconds
    });
  }

  /** Clear the refresh cookie with environment-aware security settings. */
  private clearRefreshCookie(req: Request, res: Response): void {
    const isDev = this.isDevEnvironment(req);

    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: isDev ? false : true,
      sameSite: isDev ? 'lax' : 'none',
      path: '/api/auth',
    });
  }

  // ─── OIDC callback (Authentik) ─────────────────────────────────────────────
  // The frontend redirects the user to Authentik, which redirects back with a
  // `code`.  The frontend then POSTs that code here so we can exchange it for
  // tokens server-side (keeping the client_secret safe).
  /** Exchanges an Authentik authorization code for internal JWT tokens and upserts the local user. */
  @Post('oidc/callback')
  @HttpCode(200)
  async oidcCallback(
    @Body() body: OidcCallbackDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): Promise<{
    access_token: string;
    user: {
      id: string;
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
    if (!redirect_uri) throw new BadRequestException('redirect_uri is required');

    if (!this.authentikBaseUrl || !this.authentikClientId || !this.authentikClientSecret) {
      throw new BadRequestException('Authentik OIDC is not configured on the server');
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
        `Authentik token exchange failed (${tokenRes.status}): ${errText}`
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
      throw new UnauthorizedException('Failed to fetch user info from Authentik');
    }

    const userinfo = (await userinfoRes.json()) as {
      sub: string;
      name?: string;
      promo?: number;
      firstName?: string;
      lastName?: string;
      formation?: string;
    };

    if (!userinfo.sub) {
      throw new UnauthorizedException('Invalid userinfo response from Authentik');
    }

    // 3. Upsert local user
    const promo = typeof userinfo.promo === 'number' ? userinfo.promo : null;
    const user = await this.usersService.findOrCreateFromOidc(
      userinfo.sub,
      userinfo.name || null,
      userinfo.firstName || null,
      userinfo.lastName || null,
      promo,
      userinfo.formation || null
    );

    const platformConfig = await this.platformService.getConfig();
    if (this.platformService.isAccessBlockedByMaintenance(platformConfig, !!user.admin)) {
      throw new ServiceUnavailableException({
        code: 'MAINTENANCE',
        message:
          platformConfig.maintenanceMessage ||
          'Canari is under maintenance. Please try again later.',
      });
    }

    // 4. Issue internal JWT pair
    const access_token = jwt.sign({ sub: user.id, admin: !!user.admin }, this.jwtSecret, {
      expiresIn: '1h',
    });
    const refresh_token = jwt.sign({ sub: user.id, type: 'refresh' }, this.jwtSecret, {
      expiresIn: '7d',
    });

    // Set refresh token as HttpOnly cookie (not accessible to JS)
    this.setRefreshCookie(req, res, refresh_token);

    return {
      access_token,
      user: {
        id: user.id,
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
  /** Rotates the refresh cookie and returns a new short-lived access token. */
  @Post('refresh')
  @HttpCode(200)
  async refreshToken(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ access_token: string }> {
    const refresh_token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!refresh_token) {
      this.clearRefreshCookie(req, res);
      throw new UnauthorizedException('No refresh token - please log in again');
    }

    let payload: { sub: string; type: string };
    try {
      payload = jwt.verify(refresh_token, this.jwtSecret, {
        algorithms: ['HS256'],
      }) as {
        sub: string;
        type: string;
      };
    } catch {
      this.clearRefreshCookie(req, res);
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    if (payload.type !== 'refresh') {
      this.clearRefreshCookie(req, res);
      throw new UnauthorizedException('Invalid token type');
    }

    // Look up the user to get current admin status
    const user = await this.usersService.findOne(payload.sub).catch(() => null);
    const isAdmin = !!user?.admin;

    const platformConfig = await this.platformService.getConfig();
    if (this.platformService.isAccessBlockedByMaintenance(platformConfig, isAdmin)) {
      this.clearRefreshCookie(req, res);
      throw new ServiceUnavailableException({
        code: 'MAINTENANCE',
        message:
          platformConfig.maintenanceMessage ||
          'Canari is under maintenance. Please try again later.',
      });
    }

    const access_token = jwt.sign({ sub: payload.sub, admin: isAdmin }, this.jwtSecret, {
      expiresIn: '1h',
    });
    const new_refresh = jwt.sign({ sub: payload.sub, type: 'refresh' }, this.jwtSecret, {
      expiresIn: '7d',
    });

    // Rotate the refresh cookie
    this.setRefreshCookie(req, res, new_refresh);

    return { access_token };
  }

  // ─── Logout ────────────────────────────────────────────────────────────────
  /** Clears the refresh cookie and invalidates the session. */
  @Post('logout')
  @HttpCode(200)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): { ok: true } {
    this.clearRefreshCookie(req, res);
    return { ok: true };
  }

  // ─── Verify (used by nginx auth_request) ──────────────────────────────────
  /** Verifies the Bearer token and injects X-User-Id / X-Logged-In headers for nginx auth_request (GET). */
  @Get('verify')
  verifyStart(@Req() req: Request, @Res() res: Response) {
    void this.check(req, res);
  }

  /** Verifies the Bearer token and injects X-User-Id / X-Logged-In headers for nginx auth_request (HEAD). */
  @Head('verify')
  verify(@Req() req: Request, @Res() res: Response) {
    void this.check(req, res);
  }

  private async check(req: Request, res: Response) {
    const rawHeaders = req.headers['authorization'];

    // Default: not authenticated - headers are always set so downstream services
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
      const payload = jwt.verify(token, this.jwtSecret, {
        algorithms: ['HS256'],
      }) as {
        sub: string;
        admin?: boolean;
      };

      const platformConfig = await this.platformService.getConfig();
      if (this.platformService.isAccessBlockedByMaintenance(platformConfig, !!payload.admin)) {
        res.set('X-Maintenance-Mode', 'true');
        return res.status(503).json({
          code: 'MAINTENANCE',
          message:
            platformConfig.maintenanceMessage ||
            'Canari is under maintenance. Please try again later.',
        });
      }

      res.set('X-User-Id', payload.sub);
      res.set('X-Logged-In', 'true');
      res.set('X-Global-Admin', payload.admin ? 'true' : 'false');

      // Mint a per-minute HMAC token so backend services can verify the request
      // genuinely came through nginx (not from a compromised container).
      if (this.internalSecret) {
        const epochMinute = Math.floor(Date.now() / 60000);
        const hmac = createHmac('sha256', this.internalSecret)
          .update(`${payload.sub}:${epochMinute}`)
          .digest('hex');
        res.set('X-Internal-Token', hmac);
      }

      return res.status(200).send();
    } catch {
      // Invalid/expired token - pass through as anonymous; the service decides
      // whether to reject the request.
      return res.status(200).send();
    }
  }
}
