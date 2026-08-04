import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Head,
  HttpCode,
  Param,
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
import {
  AuthSessionsService,
  SESSION_TTL_SECONDS,
  type SessionClientInfo,
} from './auth-sessions.service';

interface OidcCallbackDto {
  code: string;
  redirect_uri: string;
}

/** Claims carried by the refresh JWT. `sid`/`jti` are absent on tokens issued before WP-SESS-2. */
interface RefreshClaims {
  sub: string;
  type: string;
  sid?: string;
  jti?: string;
}

/** One session as returned by `GET /api/auth/sessions`. */
interface SessionDto {
  id: string;
  current: boolean;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  userAgent: string | null;
  lastIp: string | null;
}

const REFRESH_COOKIE = 'canari_refresh';
const REFRESH_MAX_AGE = SESSION_TTL_SECONDS; // 7 days in seconds - the cookie and the row must agree

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
    private readonly platformService: PlatformService,
    private readonly authSessions: AuthSessionsService
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

  /**
   * Signs a refresh JWT bound to a stored session.
   *
   * `sid` names the row and survives every rotation; `jti` names the single
   * token the row currently accepts. A token whose `jti` no longer matches has
   * already been spent - see {@link AuthSessionsService.rotate}.
   */
  private signRefreshToken(userId: string, sessionId: string, tokenId: string): string {
    return jwt.sign(
      { sub: userId, type: 'refresh', sid: sessionId, jti: tokenId },
      this.jwtSecret,
      {
        expiresIn: REFRESH_MAX_AGE,
      }
    );
  }

  /**
   * Facts recorded on the session so its owner can recognise it later.
   *
   * The IP is taken from the LAST `X-Forwarded-For` entry, not the first: nginx
   * appends the connecting address to whatever the client sent, so the head of
   * that list is attacker-controlled and only the tail is what nginx actually
   * saw.
   */
  private clientInfo(req: Request): SessionClientInfo {
    const forwarded = req.headers['x-forwarded-for'];
    const chain = Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '');
    const hops = String(chain)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    return {
      userAgent: req.get('user-agent') ?? null,
      ip: hops.length > 0 ? hops[hops.length - 1] : (req.socket?.remoteAddress ?? null),
    };
  }

  /**
   * Resolves the caller of a session-management route from its Bearer access token.
   *
   * These routes live under `/api/auth`, which nginx serves unauthenticated and
   * where it deliberately blanks `X-User-Id` - so `NginxAuthGuard` would refuse
   * every request. The token is verified here instead, exactly as
   * `/api/auth/verify` does it.
   */
  private requireAccessToken(req: Request): { userId: string; isAdmin: boolean } {
    const header = req.headers['authorization'];
    if (!header) throw new UnauthorizedException('Missing Authorization header');
    const parts = String(header).split(' ');
    const token = parts.length > 1 ? parts[1] : parts[0];
    if (!token) throw new UnauthorizedException('Missing bearer token');

    let payload: { sub?: string; admin?: boolean; type?: string };
    try {
      payload = jwt.verify(token, this.jwtSecret, { algorithms: ['HS256'] }) as typeof payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    // A refresh token is signed with the same key, so nothing but this check
    // stops it from being presented as an access token.
    if (payload.type === 'refresh')
      throw new UnauthorizedException('Refresh token is not an access token');
    if (!payload.sub) throw new UnauthorizedException('Token carries no subject');
    return { userId: payload.sub, isAdmin: !!payload.admin };
  }

  /** Reads the `sid` of the refresh cookie, if one is present and parsable. Never throws. */
  private currentSessionId(req: Request): string | null {
    const cookie = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!cookie) return null;
    try {
      const payload = jwt.verify(cookie, this.jwtSecret, {
        algorithms: ['HS256'],
      }) as RefreshClaims;
      return payload.type === 'refresh' ? (payload.sid ?? null) : null;
    } catch {
      return null;
    }
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

    // 4. Issue internal JWT pair, backed by a session row so the refresh can be revoked
    const access_token = jwt.sign({ sub: user.id, admin: !!user.admin }, this.jwtSecret, {
      expiresIn: '1h',
    });
    const session = await this.authSessions.create(user.id, this.clientInfo(req));
    const refresh_token = this.signRefreshToken(user.id, session.sessionId, session.tokenId);

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
  /**
   * Rotates the refresh cookie against its stored session and returns a new
   * short-lived access token.
   *
   * The signature alone is not enough to be let in: the token also has to name
   * a live session AND be the one that session currently expects. That second
   * condition is the whole point - it is what makes `logout`, "sign out this
   * device" and replay detection possible.
   */
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

    let payload: RefreshClaims;
    try {
      payload = jwt.verify(refresh_token, this.jwtSecret, {
        algorithms: ['HS256'],
      }) as RefreshClaims;
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
      // Do NOT touch the session here: maintenance is a temporary refusal, and
      // consuming the rotation would sign the user out of a healthy session.
      this.clearRefreshCookie(req, res);
      throw new ServiceUnavailableException({
        code: 'MAINTENANCE',
        message:
          platformConfig.maintenanceMessage ||
          'Canari is under maintenance. Please try again later.',
      });
    }

    const client = this.clientInfo(req);
    let sessionId = payload.sid;
    let nextTokenId: string;

    if (!sessionId || !payload.jti) {
      // Adoption path for tokens issued before WP-SESS-2, which carry no session.
      // Refusing them would sign every logged-in user out on the deploy; they are
      // still signature-valid and unexpired, so they are worth exactly what they
      // were worth yesterday - and no more, for at most one refresh TTL (7 days)
      // after the release. Safe to delete after 2026-08-12.
      const created = await this.authSessions.create(payload.sub, client);
      sessionId = created.sessionId;
      nextTokenId = created.tokenId;
    } else {
      const result = await this.authSessions.rotate(sessionId, payload.jti, client);
      if (result.status === 'replayed' || result.status === 'unknown') {
        this.clearRefreshCookie(req, res);
        throw new UnauthorizedException(
          result.status === 'replayed'
            ? 'Refresh token reused - session revoked, please log in again'
            : 'Session revoked or expired - please log in again'
        );
      }
      nextTokenId = result.tokenId;
    }

    const access_token = jwt.sign({ sub: payload.sub, admin: isAdmin }, this.jwtSecret, {
      expiresIn: '1h',
    });
    const new_refresh = this.signRefreshToken(payload.sub, sessionId, nextTokenId);

    // Rotate the refresh cookie
    this.setRefreshCookie(req, res, new_refresh);

    return { access_token };
  }

  // ─── Logout ────────────────────────────────────────────────────────────────
  /**
   * Destroys the session behind the refresh cookie, then clears the cookie.
   *
   * Deleting the row is the part that revokes anything: clearing a cookie only
   * asks the browser in front of us to forget a credential that would still
   * have worked for another seven days anywhere else.
   */
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ ok: true }> {
    const sessionId = this.currentSessionId(req);
    if (sessionId) await this.authSessions.revoke(sessionId);
    this.clearRefreshCookie(req, res);
    return { ok: true };
  }

  // ─── Session management ────────────────────────────────────────────────────
  /** Lists the caller's live sessions, flagging the one this request came from. */
  @Get('sessions')
  async listSessions(@Req() req: Request): Promise<{ sessions: SessionDto[] }> {
    const { userId } = this.requireAccessToken(req);
    const currentId = this.currentSessionId(req);
    const rows = await this.authSessions.listForUser(userId);
    return {
      sessions: rows.map((row) => ({
        id: row.id,
        current: row.id === currentId,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        userAgent: row.userAgent,
        lastIp: row.lastIp,
      })),
    };
  }

  /**
   * Revokes every session of the caller except the one making the request.
   *
   * Declared before `sessions/:id` on purpose - a parameterised route registered
   * first would swallow this path.
   */
  @Delete('sessions')
  @HttpCode(200)
  async revokeOtherSessions(@Req() req: Request): Promise<{ revoked: number }> {
    const { userId } = this.requireAccessToken(req);
    const currentId = this.currentSessionId(req);
    const revoked = await this.authSessions.revokeOthers(userId, currentId);
    return { revoked };
  }

  /** Revokes one of the caller's sessions. Revoking the current one is a logout. */
  @Delete('sessions/:id')
  @HttpCode(200)
  async revokeSession(
    @Param('id') id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ ok: boolean }> {
    const { userId } = this.requireAccessToken(req);
    // Scoped to the caller: a session id is an identifier, never an authorization.
    const ok = await this.authSessions.revokeOwned(userId, id);
    if (ok && this.currentSessionId(req) === id) {
      this.clearRefreshCookie(req, res);
    }
    return { ok };
  }

  // ─── Verify (used by nginx auth_request) ──────────────────────────────────
  /** Verifies the Bearer token and injects X-User-Id / X-Logged-In headers for nginx auth_request (GET). */
  @Get('verify')
  verifyStart(@Req() req: Request, @Res() res: Response) {
    // Returning the promise rather than discarding it: nothing else would ever
    // observe a rejection from `check`, and a test cannot await a void call.
    return this.check(req, res);
  }

  /** Verifies the Bearer token and injects X-User-Id / X-Logged-In headers for nginx auth_request (HEAD). */
  @Head('verify')
  verify(@Req() req: Request, @Res() res: Response) {
    return this.check(req, res);
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
        type?: string;
      };

      // The refresh token is signed with the same key, so it verifies here too.
      // Nothing but this check stops it from being spent as an access token -
      // which would hand a 7-day credential the reach of a 1-hour one.
      if (payload.type === 'refresh') {
        return res.status(200).send();
      }

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
