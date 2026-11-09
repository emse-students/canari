import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { KeyObject } from 'node:crypto';
import {
  destIsAllowed,
  ECOSYSTEM_SITES,
  HANDOFF_LANDING_PATH,
  HandoffRefusal,
  handoffSite,
  type EcosystemSiteContract,
  type HandoffRefusalCode,
} from './handoff-sites';
import {
  HANDOFF_TOKEN_LIFETIME_SECONDS,
  loadHandoffSigningKey,
  newHandoffJti,
  publicJwk,
  signHandoffToken,
  type HandoffPublicJwk,
} from './handoff-token';

/** Injection token for the registry, so a test can hand the service a site whose flag is ON. */
export const HANDOFF_SITES = Symbol('HANDOFF_SITES');

/** What a mint answers: the URL to open, composed here and never by the client. */
export interface HandoffMint {
  url: string;
  expiresInSeconds: number;
}

/**
 * The issuer of this estate: the origin of `FRONTEND_URL`'s FIRST entry, the estate's canonical
 * name (the same rule `restore-config.ts` reads its RP ID by). Null when it names no origin.
 */
export function handoffIssuer(frontendUrl: string | undefined): string | null {
  const first = (frontendUrl ?? '').split(',')[0]?.trim() ?? '';
  try {
    const origin = new URL(first).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * MINTS THE ONE-TIME SIGN-IN HANDOFF (docs/wiki/sessions.md, "The sign-in handoff";
 * the design: docs/wiki/backlog.d/sign-in-handoff-to-the-ecosystem-sites-and-migallery-notifications.md).
 *
 * Canari, signed in, opens a sibling site that signs in through MiConnect: this service writes a
 * 60-second ES256 token naming the caller (`sub`), the site (`aud`) and the page (`dest`), and the
 * URL `<site origin>/auth/handoff#<token>`. The site redeems it once, server-side, and opens its
 * own ordinary session. The token rides in the FRAGMENT, which no browser sends to a server.
 *
 * Stateless here: single use is the SITE's durable ledger (`jti` as a primary key), which is where
 * a replay would land. What this side owes is that only a live Canari session mints, only for a
 * site and a page of the closed registry, and that every mint leaves one audit line - and that the
 * token itself is never logged.
 *
 * FAILS CLOSED: without `HANDOFF_SIGNING_KEY`, or with an issuer `FRONTEND_URL` cannot give, the
 * route answers `HANDOFF_NOT_OFFERED` (404) and the JWKS does not exist. A key that is set but
 * unreadable is said at `error` at boot, never degraded to something weaker.
 */
@Injectable()
export class HandoffService {
  private readonly logger = new Logger('Handoff');
  private readonly signer: { key: KeyObject; jwk: HandoffPublicJwk; issuer: string } | null;
  private readonly sites: readonly EcosystemSiteContract[];

  constructor(@Optional() @Inject(HANDOFF_SITES) sites?: readonly EcosystemSiteContract[]) {
    this.sites = sites ?? ECOSYSTEM_SITES;
    this.signer = this.readSigner();
  }

  private readSigner(): { key: KeyObject; jwk: HandoffPublicJwk; issuer: string } | null {
    const raw = process.env.HANDOFF_SIGNING_KEY?.trim() ?? '';
    if (!raw) {
      // The configured state of an estate no site trusts yet (dev): said once, at boot.
      this.logger.log(
        '[HANDOFF] HANDOFF_SIGNING_KEY is unset - no sign-in handoff is minted on this estate, and every site opens plainly'
      );
      return null;
    }
    const issuer = handoffIssuer(process.env.FRONTEND_URL);
    if (!issuer) {
      this.logger.error(
        '[HANDOFF] HANDOFF_SIGNING_KEY is set but FRONTEND_URL names no origin to issue as - the handoff stays CLOSED'
      );
      return null;
    }
    try {
      const key = loadHandoffSigningKey(raw);
      const jwk = publicJwk(key);
      this.logger.log(`[HANDOFF] signing as iss=${issuer} kid=${jwk.kid}`);
      return { key, jwk, issuer };
    } catch (e) {
      this.logger.error(
        `[HANDOFF] HANDOFF_SIGNING_KEY is unreadable (${e instanceof Error ? e.message : String(e)}) - the handoff stays CLOSED`
      );
      return null;
    }
  }

  /** Whether this estate mints at all. */
  get offered(): boolean {
    return this.signer !== null;
  }

  /** Throws `HANDOFF_NOT_OFFERED` (404) where this estate holds no usable key. */
  assertOffered(): void {
    this.requireSigner();
  }

  private requireSigner(): { key: KeyObject; jwk: HandoffPublicJwk; issuer: string } {
    if (!this.signer) throw this.refuse(HandoffRefusal.notOffered, 'no handoff on this estate');
    return this.signer;
  }

  /** The JWKS the sites verify with. Throws `HANDOFF_NOT_OFFERED` where there is no key. */
  jwks(): { keys: HandoffPublicJwk[] } {
    return { keys: [this.requireSigner().jwk] };
  }

  /**
   * Mints a token for `userId` - the subject of a VERIFIED, LIVE access token, never a value from
   * the body - towards site `aud`, landing on `dest`. Refusals are typed and logged at `warn`.
   */
  mint(userId: string, aud: unknown, dest: unknown, nowMs: number = Date.now()): HandoffMint {
    const signer = this.requireSigner();
    const found = handoffSite(aud, this.sites);
    if ('refusal' in found) {
      this.logger.warn(
        `[HANDOFF] refused class=${found.refusal} aud=${JSON.stringify(String(aud).slice(0, 40))} user=${userId}`
      );
      throw this.refuse(found.refusal, 'this site cannot be opened with a handoff');
    }
    const { site } = found;
    const path = dest === undefined ? '/' : dest;
    if (typeof path !== 'string' || !destIsAllowed(path, site.dests)) {
      this.logger.warn(
        `[HANDOFF] refused class=${HandoffRefusal.badDest} aud=${site.id} user=${userId}`
      );
      throw this.refuse(HandoffRefusal.badDest, 'this page cannot be opened with a handoff');
    }

    const iat = Math.floor(nowMs / 1000);
    const jti = newHandoffJti();
    const token = signHandoffToken(signer.key, signer.jwk.kid, {
      iss: signer.issuer,
      aud: site.id,
      sub: userId,
      jti,
      iat,
      exp: iat + HANDOFF_TOKEN_LIFETIME_SECONDS,
      dest: path,
    });
    // THE AUDIT LINE, always - and never the token, here or anywhere.
    this.logger.log(`[HANDOFF] minted aud=${site.id} user=${userId} jti=${jti} dest=${path}`);
    return {
      url: `${site.origin}${HANDOFF_LANDING_PATH}#${token}`,
      expiresInSeconds: HANDOFF_TOKEN_LIFETIME_SECONDS,
    };
  }

  private refuse(code: HandoffRefusalCode, message: string) {
    const body = { code, message };
    return code === HandoffRefusal.notOffered
      ? new NotFoundException(body)
      : new BadRequestException(body);
  }
}
