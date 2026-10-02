import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { UsersService } from '../users/users.service';

/** The cookie that proves a global admin opened an Adminer session. Not the access token. */
export const ADMINER_COOKIE = 'canari_adminer';
/** The only path the browser sends it on - nothing else on the site ever sees it. */
export const ADMINER_COOKIE_PATH = '/adminer/';
/** How long a session lasts. Fixed from the moment it is opened: there is no sliding extension. */
export const ADMINER_SESSION_SECONDS = 15 * 60;

/** A secret shorter than this is not one - refused, so a typo cannot silently weaken the gate. */
const MIN_SECRET_LENGTH = 32;
/** Domain separation: the shared secret also signs `X-Internal-Token`, and must not sign two things the same way. */
const KEY_LABEL = 'canari-adminer-cookie-v1';

/**
 * THE GATE IN FRONT OF THE DATABASE ADMIN UI (user, 2026-10-02: *"add an adminer route to canari, in
 * a safe way"*).
 *
 * A browser that OPENS a page sends no `Authorization` header - and nginx's `auth_request`
 * (`/api/auth/verify`) reads nothing else - so a route reached by navigation has no identity of its
 * own, and the app keeps its access token in memory on purpose, never in a cookie. This is the
 * smallest credential that can stand in for it: a global admin, signed in to the app, asks for a
 * session over an authenticated call; the answer is a cookie that is
 *
 * - **signed** (HMAC-SHA256 over the user and the expiry, with a key derived from the shared secret),
 *   so nothing is stored and a forged or edited one fails;
 * - **short**: 15 minutes from the moment it was issued, with no renewal;
 * - **scoped**: `HttpOnly`, `Secure`, `SameSite=Strict`, and sent on `/adminer/` ONLY;
 * - **re-checked**: every request asks whether that user is STILL an admin, so removing the role
 *   ends the access at the next click rather than at the cookie's expiry.
 *
 * It is the FIRST of two doors. Adminer then asks for the database user and password itself - this
 * service never holds, passes on or pre-fills a database credential.
 *
 * IT FAILS CLOSED: with `ADMINER_ENABLED` unset or false, or without a long enough shared secret,
 * nothing is issued and nothing verifies. Production sets the first; development never does, so a
 * development stack has no way to open a door onto its copy of the data.
 */
@Injectable()
export class AdminerAccessService {
  private readonly logger = new Logger(AdminerAccessService.name);
  private readonly key: Buffer | null;

  constructor(private readonly users: UsersService) {
    const secret = process.env.INTERNAL_SHARED_SECRET?.trim() ?? '';
    const asked = process.env.ADMINER_ENABLED === 'true';
    if (asked && secret.length < MIN_SECRET_LENGTH) {
      // Said at startup and refused, never degraded: an operator who asked for the route must learn
      // it is not there, not find it open with a weak key.
      this.logger.error(
        'ADMINER_ENABLED=true but INTERNAL_SHARED_SECRET is missing or shorter than ' +
          `${MIN_SECRET_LENGTH} characters - the Adminer route stays CLOSED`
      );
    }
    this.key =
      asked && secret.length >= MIN_SECRET_LENGTH
        ? createHmac('sha256', secret).update(KEY_LABEL).digest()
        : null;
  }

  /** Whether this deployment offers the route at all. */
  get enabled(): boolean {
    return this.key !== null;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key!).update(payload).digest('base64url');
  }

  /** A signed session cookie value for `userId`, valid until `now` + {@link ADMINER_SESSION_SECONDS}. */
  mint(userId: string, now: number = Date.now()): string {
    if (!this.key) throw new Error('the Adminer route is not enabled');
    const payload = Buffer.from(
      JSON.stringify({ sub: userId, exp: now + ADMINER_SESSION_SECONDS * 1000 })
    ).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  /**
   * The user a cookie names, or `null` when it must not open the door: absent, malformed, forged,
   * expired, or belonging to someone who is no longer a global admin.
   */
  async verify(cookie: string | undefined, now: number = Date.now()): Promise<string | null> {
    if (!this.key || !cookie) return null;
    const dot = cookie.indexOf('.');
    if (dot < 1 || cookie.indexOf('.', dot + 1) !== -1) return null;
    const payload = cookie.slice(0, dot);
    const given = Buffer.from(cookie.slice(dot + 1), 'base64url');
    const expected = Buffer.from(this.sign(payload), 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      this.logger.warn('adminer cookie refused: bad signature');
      return null;
    }

    let claims: { sub?: unknown; exp?: unknown };
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
    if (claims.exp <= now) return null;

    const user = await this.users.findOne(claims.sub).catch(() => null);
    if (!user?.admin) {
      this.logger.warn(`adminer cookie refused: ${claims.sub} is no longer a global admin`);
      return null;
    }
    return claims.sub;
  }
}
