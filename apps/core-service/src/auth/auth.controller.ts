import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Head,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as jwt from 'jsonwebtoken';
import { createHmac } from 'crypto';
import { parseProfileClaims, type MiconnectClaims } from '../users/miconnect-profile';
import { UsersService } from '../users/users.service';
import { PlatformService } from '../platform/platform.service';
import {
  AuthSessionsService,
  SESSION_TTL_SECONDS,
  type SessionClientInfo,
} from './auth-sessions.service';
import {
  ADMINER_COOKIE,
  ADMINER_COOKIE_PATH,
  ADMINER_SESSION_SECONDS,
  AdminerAccessService,
} from './adminer-access.service';
import { TAURI_WEBVIEW_ORIGINS } from '../cors-origins';
import { REFRESH_HEADER, usesBodyRefreshTransport } from './refresh-transport';
import { ACCESS_TOKEN_TTL_SECONDS } from './token-lifetimes';
import {
  AccountErasureService,
  type ErasureState,
} from '../account-erasure/account-erasure.service';
import type { User } from '../users/entities/user.entity';
import { RestoreCredentialsService } from './restore/restore-credentials.service';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

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
  /** MLS device this login belongs to, or null when the client never named one. */
  deviceId: string | null;
}

/** Body of `PUT /auth/sessions/current/device`. */
interface BindDeviceDto {
  deviceId?: unknown;
}

/** Body of `POST /auth/restore/registration`. */
interface RestoreRegistrationDto {
  response?: unknown;
  /** What the phone did: true when the key went to the Google backup, false on the second path. */
  cloudBackup?: unknown;
}

/** Body of `POST /auth/restore/assertion`. */
interface RestoreAssertionDto {
  response?: unknown;
}

/** The account as a sign-in answers it - the MiConnect callback and a restore return the same shape. */
interface SignedInUserDto {
  id: string;
  displayName: string;
  promo: number | null;
  firstName: string | null;
  lastName: string | null;
  bio: string | null;
  admin: boolean;
}

/** What a sign-in answers, whichever way the account was proven. */
interface IssuedSession {
  access_token: string;
  /** Present only for a client whose engine cannot keep the cookie - see `refresh-transport.ts`. */
  refresh_token?: string;
  user: SignedInUserDto;
}

/**
 * The origins of the Android app's WebView. A restore key is created by Android's Credential
 * Manager for this app, so a registration from any other origin is not this app - and refusing it
 * is what stops a script holding a web session (an XSS) from registering a key of its own: a browser
 * cannot forge `Origin` (docs/wiki/account-restore.md, threat model).
 */
const ANDROID_APP_ORIGINS: readonly string[] = [
  'http://tauri.localhost',
  'https://tauri.localhost',
];

/** A restore refusal, as a code the client branches on (never on the message). */
function restoreRefusal(code: string, message: string): { code: string; message: string } {
  return { code, message };
}

const REFRESH_COOKIE = 'canari_refresh';
const REFRESH_MAX_AGE = SESSION_TTL_SECONDS; // 7 days in seconds - the cookie and the row must agree

/** Controller handling OIDC login, token refresh, logout, and nginx JWT verification. */
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private readonly jwtSecret: string;
  private readonly authentikBaseUrl: string;
  private readonly authentikClientId: string;
  private readonly authentikClientSecret: string;
  private readonly isProduction: boolean;
  /**
   * Whether the refresh cookie may be issued without `Secure` and with `SameSite=lax`.
   *
   * A DEPLOYMENT FACT, READ FROM CONFIGURATION - never from the request, and never from the domain.
   * There is deliberately no default: the value decides whether a credential crosses the network
   * unprotected, and a variable nobody set is not an answer to that.
   */
  private readonly allowInsecureCookies: boolean;
  /** Shared secret used to sign X-Internal-Token HMAC headers for inter-service auth. */
  private readonly internalSecret: string;

  constructor(
    private readonly usersService: UsersService,
    private readonly platformService: PlatformService,
    private readonly authSessions: AuthSessionsService,
    private readonly adminerAccess: AdminerAccessService,
    private readonly accountErasure: AccountErasureService,
    private readonly restoreCredentials: RestoreCredentialsService
  ) {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret === 'change-me-in-production') {
      throw new Error(
        'JWT_SECRET must be set to a strong random value (e.g. openssl rand -hex 32)'
      );
    }
    this.jwtSecret = secret;
    this.isProduction = process.env.NODE_ENV === 'production';

    // THE COOKIE'S SECURITY ATTRIBUTES COME FROM CONFIGURATION, AND THAT IS A REPAIR (2026-09-01).
    // Until this commit they were decided per request, from `Origin` or `Referer`: outside
    // production, any caller sending `Origin: http://localhost` was handed a refresh cookie with
    // `Secure` off and `SameSite=lax`, on the strength of a header the caller writes. It also made
    // a SECOND HTTPS environment unrepresentable - the only way to ask for production's attributes
    // was to be production - which is exactly what `dev.canari-emse.fr` needs, since it is served
    // over HTTPS behind the tunnel and must keep them.
    const insecureCookies = process.env.ALLOW_INSECURE_COOKIES;
    if (this.isProduction) {
      // Refused rather than ignored: silently overriding it would hide a deployment that believes
      // it asked for something else.
      if (insecureCookies === 'true') {
        throw new Error(
          'ALLOW_INSECURE_COOKIES=true with NODE_ENV=production would issue the refresh cookie ' +
            'without Secure over HTTPS. Remove the variable, or set it to false.'
        );
      }
      this.allowInsecureCookies = false;
    } else {
      if (insecureCookies !== 'true' && insecureCookies !== 'false') {
        throw new Error(
          'ALLOW_INSECURE_COOKIES must be set to "true" or "false" whenever NODE_ENV is not ' +
            '"production" (it is currently ' +
            JSON.stringify(process.env.NODE_ENV ?? null) +
            '). Use true for a stack served over plain HTTP on localhost, false for anything ' +
            'reached over HTTPS. It has no default on purpose: the value decides whether the ' +
            'refresh cookie carries Secure.'
        );
      }
      this.allowInsecureCookies = insecureCookies === 'true';
    }

    this.authentikBaseUrl = (process.env.AUTHENTIK_BASE_URL || '').replace(/\/+$/, '');
    this.authentikClientId = process.env.AUTHENTIK_CLIENT_ID || '';
    this.authentikClientSecret = process.env.AUTHENTIK_CLIENT_SECRET || '';
    this.internalSecret = process.env.INTERNAL_SHARED_SECRET?.trim() ?? '';
  }

  /**
   * Sets the refresh token as an HttpOnly cookie.
   *
   * The attributes are the DEPLOYMENT's, not the request's - see {@link allowInsecureCookies}. Every
   * environment reached over HTTPS, production and `dev.canari-emse.fr` alike, gets
   * `Secure` with `SameSite=none`, because the mobile app calls in cross-origin from
   * `tauri.localhost`.
   */
  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: !this.allowInsecureCookies,
      sameSite: this.allowInsecureCookies ? 'lax' : 'none',
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
  private requireAccessToken(req: Request): {
    userId: string;
    isAdmin: boolean;
  } {
    const header = req.headers['authorization'];
    if (!header) throw new UnauthorizedException('Missing Authorization header');
    const parts = String(header).split(' ');
    const token = parts.length > 1 ? parts[1] : parts[0];
    if (!token) throw new UnauthorizedException('Missing bearer token');

    let payload: { sub?: string; admin?: boolean; type?: string };
    try {
      payload = jwt.verify(token, this.jwtSecret, {
        algorithms: ['HS256'],
      }) as typeof payload;
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

  /**
   * The refresh credential this request presents, by whichever transport its platform can use.
   *
   * The choice is made from the caller's `Origin` - a fact already in hand - and never by trying the
   * cookie and reading the failure. A client whose engine cannot keep a third-party cookie sends the
   * credential in {@link REFRESH_HEADER} instead; everyone else sends the cookie, and for them the
   * header is not even consulted, so presenting one cannot become a way around the cookie.
   */
  /**
   * Whether THIS request's client carries its refresh credential itself, from the two facts that
   * decide it: the caller's origin, and whether this deployment can issue a cookie a third-party
   * context accepts.
   *
   * The second is `!allowInsecureCookies` - the same flag `setRefreshCookie` reads to choose between
   * `SameSite=None; Secure` and `SameSite=Lax`. It is spelled ONCE, here, because five call sites
   * each re-deriving it is five chances for one of them to keep the old answer.
   */
  private carriesOwnRefreshCredential(origin: string | undefined): boolean {
    return usesBodyRefreshTransport(origin, !this.allowInsecureCookies);
  }

  private presentedRefreshToken(req: Request): string | undefined {
    const cookie = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!this.carriesOwnRefreshCredential(req.get('origin'))) return cookie;

    // The header is authoritative when it is there, because a client that sends one is carrying its
    // own copy and rotating it - the cookie beside it, if any, is a value it stopped maintaining.
    const carried = req.get(REFRESH_HEADER);
    if (carried && carried.length > 0) return carried;

    // No header from an origin that could have sent one means a client that predates this transport.
    // `tauri://localhost` is not only iOS: the Linux AppImage and macOS share it, and on those the
    // cookie may work perfectly. Refusing it here would log those users out on a deploy, so the
    // cookie is still read - and this is the whole of the shim, recorded with its removal condition
    // in `docs/wiki/legacy-compatibility.md`.
    return cookie;
  }

  /** Reads the `sid` of the presented refresh credential, if one is present and parsable. Never throws. */
  private currentSessionId(req: Request): string | null {
    const cookie = this.presentedRefreshToken(req);
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

  /**
   * Clears the refresh cookie.
   *
   * The attributes MUST match the ones it was set with, or the browser keeps the cookie - which is
   * why this reads the same {@link allowInsecureCookies} and not a second copy of the decision.
   */
  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: !this.allowInsecureCookies,
      sameSite: this.allowInsecureCookies ? 'lax' : 'none',
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
    /** Present only for a client whose engine cannot keep the cookie - see `refresh-transport.ts`. */
    refresh_token?: string;
    /**
     * MiConnect's id_token, handed on for ONE use: the `id_token_hint` the client's sign-out sends to
     * MiConnect's end-session, which refuses a return address without it. It authenticates nothing
     * here or there (docs/wiki/infrastructure/authentik.md, "Signing out of Canari ends MiConnect").
     */
    id_token?: string;
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
      firstName?: string;
      lastName?: string;
    } & MiconnectClaims;

    if (!userinfo.sub) {
      throw new UnauthorizedException('Invalid userinfo response from Authentik');
    }

    // 3. Refuse an account whose erasure is still running. `users.id` IS the OIDC subject, so a
    // sign-in now would recreate the account under the same id, and the erasure's next pass would
    // then delete what the new account wrote. Once every job has completed the person may come back
    // and gets a new, empty account. Checked again once the session exists (step 5b), because a
    // deletion can commit between here and there.
    this.refuseDuringErasure(userinfo.sub, await this.accountErasure.erasureState(userinfo.sub));

    // 4. Upsert local user
    const user = await this.usersService.findOrCreateFromOidc(
      userinfo.sub,
      userinfo.name || null,
      userinfo.firstName || null,
      userinfo.lastName || null,
      parseProfileClaims(userinfo)
    );

    await this.refuseDuringMaintenance(user);

    // 4b. Grant any cotisation a legacy estate recorded for them. On every sign-in, not just the
    // first: the claim terminates on durable state in social-service, so this is idempotent, and
    // a user who signed in before their association's list was loaded still gets their tag.
    await this.usersService.claimLegacyCotisations(user);

    // 5. Issue internal JWT pair, backed by a session row so the refresh can be revoked.
    const issued = await this.issueSession(user, req, res);

    if (!tokenData.id_token) {
      // An `openid` exchange always carries one, so its absence is a provider misconfiguration - and
      // this user's sign-out will leave their MiConnect session alive.
      this.logger.warn(
        'OIDC callback: Authentik returned no id_token - the sign-out cannot end MiConnect'
      );
    }

    return {
      ...issued,
      ...(tokenData.id_token ? { id_token: tokenData.id_token } : {}),
    };
  }

  /** Refuses a non-admin sign-in while the platform is in maintenance (503 `MAINTENANCE`). */
  private async refuseDuringMaintenance(user: User): Promise<void> {
    const platformConfig = await this.platformService.getConfig();
    if (this.platformService.isAccessBlockedByMaintenance(platformConfig, !!user.admin)) {
      throw new ServiceUnavailableException({
        code: 'MAINTENANCE',
        message:
          platformConfig.maintenanceMessage ||
          'Canari is under maintenance. Please try again later.',
      });
    }
  }

  /**
   * MINTS A SESSION FOR AN ACCOUNT ALREADY PROVEN - the one sequence the MiConnect callback and a
   * restore share, so the two can never drift (docs/wiki/account-restore.md).
   *
   * The access token, the session row, the erasure check that only the row can close, the cookie for
   * everyone and the body copy for the clients that carry their own credential.
   */
  private async issueSession(user: User, req: Request, res: Response): Promise<IssuedSession> {
    const access_token = jwt.sign({ sub: user.id, admin: !!user.admin }, this.jwtSecret, {
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });
    const session = await this.authSessions.create(user.id, this.clientInfo(req));
    const refresh_token = this.signRefreshToken(user.id, session.sessionId, session.tokenId);

    // The race the check before the mint cannot close: a `DELETE /users/me` that committed after it.
    // Under the erasure's per-subject lock, so it is either seen here (and what this sign-in wrote is
    // erased again) or it runs after, deletes this session itself, and covers the access token with
    // its final pass. The tokens are only returned once this has passed.
    this.refuseDuringErasure(user.id, await this.accountErasure.confirmAfterSignIn(user.id));

    // The cookie is set for EVERY client, including the ones that will drop it: it is unreadable by
    // the page's own JavaScript, so it stays the preferred transport wherever it survives - and
    // `tauri://localhost` covers desktop builds where it may well survive. The body copy is added
    // only for origins whose engine can refuse the cookie, and only they are told to carry it.
    this.setRefreshCookie(res, refresh_token);
    const bodyTransport = this.carriesOwnRefreshCredential(req.get('origin'));
    if (bodyTransport) {
      this.logger.debug(
        `Session issued: credential also returned in the body (origin=${req.get('origin')} may not keep a third-party cookie)`
      );
    }
    return {
      access_token,
      ...(bodyTransport ? { refresh_token } : {}),
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

  /**
   * Refuses a sign-in while the account's erasure is not finished. `blocked` (a permanent failure,
   * which a retry has not been shown to fix) sends the person to a human rather than telling them to
   * wait. Two codes because the client renders two different messages.
   */
  private refuseDuringErasure(subject: string, erasure: ErasureState): void {
    if (erasure === 'none') return;
    this.logger.warn(
      `[AUTH] sign-in refused: account erasure ${erasure} user=${subject.slice(0, 8)}`
    );
    throw new ForbiddenException(
      erasure === 'blocked'
        ? {
            code: 'ACCOUNT_ERASURE_BLOCKED',
            message: 'The deletion of this account is stuck. Contact bureau@rootz-emse.fr.',
          }
        : {
            code: 'ACCOUNT_ERASURE_PENDING',
            message: 'This account is being deleted. Try again in an hour.',
          }
    );
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
    @Res({ passthrough: true }) res: Response,
    @Query('clientVersion') clientVersion?: string
  ): Promise<{ access_token: string; refresh_token?: string }> {
    const refresh_token = this.presentedRefreshToken(req);
    if (!refresh_token) {
      // THIS 401 HAS TWO CAUSES AND CANNOT ITSELF TELL THEM APART, so the line carries the
      // evidence that does. A person who really is signed out sends no cookie - and so does a
      // WebView whose jar refused to STORE the `Set-Cookie`, because a native shell's refresh
      // cookie is third-party by construction: the document is `tauri://localhost`, the cookie is
      // `canari-emse.fr`. Android blocks that by default and needs one explicit opt-in
      // (`setAcceptThirdPartyCookies`, `MainActivity.kt`); WKWebView blocks it too and exposes NO
      // equivalent API, so iOS is the platform where this branch is expected to lie about why.
      // The cookie LIST is the discriminator: a client that holds a session still presents its
      // other cookies, a jar that dropped the whole third-party set presents none.
      // SINCE THE HEADER TRANSPORT SHIPPED THERE IS A THIRD CAUSE, and it is the only one that is a
      // defect: a client that is supposed to carry its own credential, whose store came back empty.
      // No field above separates it from the second, because a client with an empty store correctly
      // sends no header at all - "old client, has not updated yet" and "the write to disk failed"
      // look identical here. `client=` is what tells them apart, which is why it is stated rather
      // than inferred: measured 2026-08-27, every iOS device on prod was on 0.14.5, the build BEFORE
      // the transport existed, so every one of those lines was expected and none was worth chasing.
      // `unstated` means a client older than this parameter, which is the same answer.
      const cookieNames = Object.keys((req.cookies ?? {}) as Record<string, unknown>);
      const origin = req.get('origin') ?? 'none';
      // Three states, and the third is why this is not a boolean: an origin that keeps its cookie
      // has its header IGNORED by policy, so "present" there means nothing went wrong. `empty` is
      // the only one that accuses - a body-transport client that sent the header with nothing in it.
      const headerState = !req.get(REFRESH_HEADER)
        ? 'absent'
        : this.carriesOwnRefreshCredential(origin)
          ? 'empty'
          : 'ignored';
      const detail =
        `no ${REFRESH_COOKIE} cookie. cookies=[${cookieNames.join(',')}] ` +
        `${REFRESH_HEADER}=${headerState} ` +
        `client=${clientVersion?.trim() || 'unstated'} origin=${origin} ` +
        `ua=${req.get('user-agent') ?? 'none'}`;
      if (TAURI_WEBVIEW_ORIGINS.includes(origin as (typeof TAURI_WEBVIEW_ORIGINS)[number])) {
        // A native shell reaching here is not an anonymous visitor: the app only asks for a
        // refresh once it believes it has a session, so the cookie was expected to be there.
        this.logger.warn(`Refresh refused for the NATIVE app: ${detail}`);
      } else {
        // Every anonymous first page load asks once and legitimately has nothing. Debug, or the
        // log becomes a census of visitors and stops being read at all.
        this.logger.debug(`Refresh refused: ${detail}`);
      }
      this.clearRefreshCookie(res);
      throw new UnauthorizedException('No refresh token - please log in again');
    }

    let payload: RefreshClaims;
    try {
      payload = jwt.verify(refresh_token, this.jwtSecret, {
        algorithms: ['HS256'],
      }) as RefreshClaims;
    } catch (err) {
      // Every refusal below ends in a sign-out, so each one says which it was: a silent 401 here
      // was indistinguishable, in the log, from the session row being gone (2026-09-28).
      this.logger.warn(
        `Refresh refused: the token does not verify (${err instanceof Error ? err.name : typeof err})`
      );
      this.clearRefreshCookie(res);
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    if (payload.type !== 'refresh') {
      this.logger.warn(`Refresh refused: token type is '${String(payload.type)}', not 'refresh'`);
      this.clearRefreshCookie(res);
      throw new UnauthorizedException('Invalid token type');
    }

    // Look up the user to get current admin status
    const user = await this.usersService.findOne(payload.sub).catch(() => null);
    const isAdmin = !!user?.admin;

    const platformConfig = await this.platformService.getConfig();
    if (this.platformService.isAccessBlockedByMaintenance(platformConfig, isAdmin)) {
      // Do NOT touch the session here: maintenance is a temporary refusal, and
      // consuming the rotation would sign the user out of a healthy session.
      this.clearRefreshCookie(res);
      throw new ServiceUnavailableException({
        code: 'MAINTENANCE',
        message:
          platformConfig.maintenanceMessage ||
          'Canari is under maintenance. Please try again later.',
      });
    }

    const client = this.clientInfo(req);
    const sessionId = payload.sid;

    // A refresh token with no session is a token issued before WP-SESS-2. It used to be adopted
    // into a fresh session so the release would not sign everyone out; that window was one refresh
    // TTL wide and closed on 2026-08-12, so such a token is now expired by its own `exp` and cannot
    // reach this line. The branch is gone rather than kept as insurance: it MINTED a session for a
    // token nothing had verified against a row, which is precisely the property this table exists
    // to remove.
    if (!sessionId || !payload.jti) {
      this.clearRefreshCookie(res);
      this.logger.warn('Refresh token carries no session - refusing rather than adopting it');
      throw new UnauthorizedException('Session revoked or expired - please log in again');
    }

    const result = await this.authSessions.rotate(sessionId, payload.jti, client);
    if (result.status === 'replayed' || result.status === 'unknown') {
      this.clearRefreshCookie(res);
      throw new UnauthorizedException(
        result.status === 'replayed'
          ? 'Refresh token reused - session revoked, please log in again'
          : 'Session revoked or expired - please log in again'
      );
    }
    const nextTokenId = result.tokenId;

    const access_token = jwt.sign({ sub: payload.sub, admin: isAdmin }, this.jwtSecret, {
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });
    const new_refresh = this.signRefreshToken(payload.sub, sessionId, nextTokenId);

    // Rotate on BOTH transports the caller can hold, for the reason above. From this moment the old
    // value is spent, and 60 s from now it reads as a replay that revokes the row - so a client
    // carrying its own copy must persist the new one before relying on it.
    this.setRefreshCookie(res, new_refresh);
    if (this.carriesOwnRefreshCredential(req.get('origin'))) {
      return { access_token, refresh_token: new_refresh };
    }

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
    this.clearRefreshCookie(res);
    return { ok: true };
  }

  // ─── Restore keys (Android Restore Credentials, WP-RESTORE-1) ──────────────
  // docs/wiki/account-restore.md. A restore key is bound to the session that registered it and a
  // restore MOVES that session to the new phone: it never adds one.

  /** 503 `RESTORE_UNAVAILABLE` when this estate has no signing fingerprint configured. */
  private requireRestoreAvailable(): void {
    if (!this.restoreCredentials.available) {
      throw new ServiceUnavailableException(
        restoreRefusal('RESTORE_UNAVAILABLE', 'Account restore is not configured on this server')
      );
    }
  }

  /**
   * The caller's user and LIVE session, for the two registration routes - identified exactly as
   * `PUT sessions/current/device` identifies it, and refused unless the request comes from the
   * Android app (see {@link ANDROID_APP_ORIGINS}).
   */
  private async restoreRegistrationCaller(
    req: Request
  ): Promise<{ userId: string; sessionId: string }> {
    const { userId } = this.requireAccessToken(req);
    const origin = req.get('origin') ?? '';
    if (!ANDROID_APP_ORIGINS.includes(origin)) {
      this.logger.warn(
        `[RESTORE] registration refused user=${userId}: origin=${origin || 'none'} is not the Android app`
      );
      throw new ForbiddenException(
        restoreRefusal('RESTORE_ORIGIN_REFUSED', 'Restore keys are registered by the Android app')
      );
    }
    const sessionId = this.currentSessionId(req);
    if (
      !sessionId ||
      !(await this.restoreCredentials.isLiveSessionOf(userId, sessionId, new Date()))
    ) {
      this.logger.warn(`[RESTORE] registration refused user=${userId}: no live session`);
      throw new NotFoundException(restoreRefusal('RESTORE_NO_SESSION', 'No live session'));
    }
    return { userId, sessionId };
  }

  /** Creation options for the restore key of the calling session. */
  @Post('restore/registration/options')
  @HttpCode(200)
  async restoreRegistrationOptions(@Req() req: Request): Promise<unknown> {
    this.requireRestoreAvailable();
    const { sessionId } = await this.restoreRegistrationCaller(req);
    return this.restoreCredentials.registrationOptions(sessionId, new Date());
  }

  /** Verifies and stores the restore key of the calling session (replacing its previous one). */
  @Post('restore/registration')
  @HttpCode(200)
  async restoreRegistration(
    @Req() req: Request,
    @Body() body: RestoreRegistrationDto
  ): Promise<{ registered: true }> {
    this.requireRestoreAvailable();
    const { userId, sessionId } = await this.restoreRegistrationCaller(req);
    if (
      !body?.response ||
      typeof body.response !== 'object' ||
      typeof body.cloudBackup !== 'boolean'
    ) {
      throw new BadRequestException('response and cloudBackup are required');
    }
    const result = await this.restoreCredentials.register(
      userId,
      sessionId,
      body.response as RegistrationResponseJSON,
      body.cloudBackup,
      new Date()
    );
    switch (result.status) {
      case 'registered':
        return { registered: true };
      case 'no-session':
        throw new NotFoundException(restoreRefusal('RESTORE_NO_SESSION', 'No live session'));
      case 'taken':
        throw new ForbiddenException(
          restoreRefusal('RESTORE_KEY_TAKEN', 'This key belongs to another session')
        );
      case 'invalid':
        throw new BadRequestException(
          restoreRefusal('RESTORE_REGISTRATION_INVALID', 'The restore key did not verify')
        );
    }
  }

  /** Request options for an anonymous restore. Writes nothing. */
  @Post('restore/assertion/options')
  @HttpCode(200)
  async restoreAssertionOptions(): Promise<unknown> {
    this.requireRestoreAvailable();
    return this.restoreCredentials.assertionOptions(new Date());
  }

  /**
   * Signs the new phone in from a restore key, then ends the session the key was bound to.
   *
   * THE ORDER IS THE TRANSFER: the key is consumed when it verifies (the service), the new session
   * is minted through the SAME {@link issueSession} as a MiConnect sign-in, and only then is the old
   * session revoked - so a failure to mint leaves the old phone signed in and costs only the key.
   */
  @Post('restore/assertion')
  @HttpCode(200)
  async restoreAssertion(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: RestoreAssertionDto
  ): Promise<IssuedSession> {
    this.requireRestoreAvailable();
    if (!body?.response || typeof body.response !== 'object') {
      throw new BadRequestException('response is required');
    }
    const result = await this.restoreCredentials.authenticate(
      body.response as AuthenticationResponseJSON,
      new Date()
    );
    if (result.status === 'unknown') {
      throw new UnauthorizedException(
        restoreRefusal('RESTORE_KEY_UNKNOWN', 'This restore key is not valid any more')
      );
    }
    if (result.status === 'invalid') {
      throw new UnauthorizedException(
        restoreRefusal('RESTORE_ASSERTION_INVALID', 'The restore key did not verify')
      );
    }

    this.refuseDuringErasure(result.userId, await this.accountErasure.erasureState(result.userId));
    const user = await this.usersService.findOne(result.userId);
    await this.refuseDuringMaintenance(user);
    const issued = await this.issueSession(user, req, res);

    await this.authSessions.revoke(result.sessionId);
    this.logger.log(
      `[RESTORE] session moved to a restored phone user=${user.id} from sid=${result.sessionId}`
    );
    return issued;
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
        deviceId: row.deviceId,
      })),
    };
  }

  /**
   * Records which MLS device the calling session belongs to.
   *
   * This is the join between a login and a device, and it can only be written
   * here: the session is opened by the OIDC callback, long before the client
   * has unlocked MLS and knows its own device id. The client calls this once
   * per app start, after unlock - deliberately NOT on the refresh path, which
   * is the cold-start critical section and must not grow a round trip so a
   * settings panel can draw one row instead of two.
   *
   * A 404 means the session behind the cookie is gone, which the client
   * reports and does not retry: its next request is answered with a 401 anyway.
   */
  @Put('sessions/current/device')
  @HttpCode(200)
  async bindCurrentSessionDevice(
    @Req() req: Request,
    @Body() body: BindDeviceDto
  ): Promise<{ bound: true }> {
    const { userId } = this.requireAccessToken(req);
    const sessionId = this.currentSessionId(req);
    if (!sessionId) throw new UnauthorizedException('No session behind this request');
    if (typeof body?.deviceId !== 'string') throw new BadRequestException('deviceId is required');
    const bound = await this.authSessions.bindDevice(userId, sessionId, body.deviceId);
    if (!bound) throw new NotFoundException('No live session to bind');
    return { bound: true };
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
      this.clearRefreshCookie(res);
    }
    return { ok };
  }

  // ─── Adminer (database admin UI, global admins only) ───────────────────────

  /**
   * Opens an Adminer session: a global admin, authenticated by their access token, is handed the
   * short signed cookie `/adminer/` requires (see {@link AdminerAccessService}). The role is read
   * from the DATABASE, not from the token's claim - the claim can be an hour old.
   *
   * A 404 where the route is not enabled, so a stack that does not offer it does not say that it
   * exists.
   */
  @Post('adminer-session')
  @HttpCode(200)
  async openAdminerSession(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ expiresInSeconds: number }> {
    if (!this.adminerAccess.enabled) throw new NotFoundException();
    const { userId } = this.requireAccessToken(req);
    const user = await this.usersService.findOne(userId).catch(() => null);
    if (!user?.admin) {
      this.logger.warn(`adminer session refused: ${userId} is not a global admin`);
      throw new ForbiddenException('Global admin only');
    }
    res.cookie(ADMINER_COOKIE, this.adminerAccess.mint(userId), {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: ADMINER_COOKIE_PATH,
      maxAge: ADMINER_SESSION_SECONDS * 1000,
    });
    // An audit line, always: opening a door onto the database is the one thing here worth a trail.
    this.logger.warn(`adminer session opened by ${userId}`);
    return { expiresInSeconds: ADMINER_SESSION_SECONDS };
  }

  /**
   * nginx's `auth_request` for `/adminer/`: 200 when the cookie is a live session of a user who is
   * still a global admin, 401 otherwise - and nginx turns every 401 into a bare 404.
   */
  @Get('adminer-verify')
  async verifyAdminer(@Req() req: Request, @Res() res: Response) {
    const cookie = req.cookies?.[ADMINER_COOKIE] as string | undefined;
    const userId = await this.adminerAccess.verify(cookie);
    return res.status(userId ? 200 : 401).send();
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
