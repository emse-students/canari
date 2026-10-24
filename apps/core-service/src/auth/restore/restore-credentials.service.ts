import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, QueryFailedError, Repository } from 'typeorm';
import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { AuthSession } from '../entities/auth-session.entity';
import { isPreviousTokenInGrace, SWEEP_INTERVAL_MS } from '../auth-sessions.service';
import { EndedSession, SessionPushEndService } from '../session-push-end.service';
import { RestoreChallengeSpent, RestoreCredential } from './restore-credential.entity';
import {
  checkRestoreChallenge,
  deriveRestoreChallengeKey,
  mintRestoreChallenge,
  type CheckedChallenge,
  type RestoreChallengePurpose,
} from './restore-challenge';
import { readRestoreConfig, type RestoreConfig } from './restore-config';

/** The relying party's display name. Never shown for a restore key, but WebAuthn requires one. */
const RP_NAME = 'Canari';

/**
 * Outcome of {@link RestoreCredentialsService.register}. Classified here, at the throw, because the
 * controller turns each into a different status and the client into a different action.
 */
export type RegisterResult =
  /** Stored. `replaced` is the id of the session's previous key when it had a different one. */
  | { status: 'registered'; credentialId: string; replaced: string | null }
  /**
   * The calling session is gone, expired, not the caller's, or the refresh credential presented is
   * not its CURRENT one (a stale, possibly stolen, credential never registers a key).
   */
  | { status: 'no-session' }
  /** The credential id is already another session's key: never re-bound (it is client-chosen). */
  | { status: 'taken' }
  /**
   * Another registration for this session committed between this one's read and its write (two
   * starts racing): the unique session constraint refused the second. Nothing was changed by it.
   */
  | { status: 'conflict' }
  /** The response did not verify (challenge, origin, RP id, signature, format). */
  | { status: 'invalid'; reason: string };

/** Outcome of {@link RestoreCredentialsService.verifyAssertion}: a verdict, and NOTHING written. */
export type VerifyAssertionResult =
  /** The signature verified. Nothing is consumed yet: the caller's refusals keep the key. */
  | { status: 'verified'; assertion: VerifiedAssertion }
  /** No key with that id, or the session it is bound to is gone or expired. */
  | { status: 'unknown' }
  /** The assertion did not verify. */
  | { status: 'invalid'; reason: string };

/** A verified assertion, as {@link RestoreCredentialsService.consume} takes it. */
export interface VerifiedAssertion {
  userId: string;
  credentialId: string;
  sessionId: string;
  challenge: CheckedChallenge;
}

/** Outcome of {@link RestoreCredentialsService.consume}. */
export type ConsumeResult =
  /** The key and the session it was bound to are gone, in one transaction. */
  | { status: 'consumed' }
  /** Another assertion consumed the key first. */
  | { status: 'unknown' }
  /** The challenge was already spent: a replay. */
  | { status: 'invalid'; reason: 'replay' };

/** The shortest prefix of a credential id that identifies it in a log line. */
function shortId(id: string | undefined): string {
  return (id ?? '').slice(0, 8) || 'none';
}

/** Whether `e` is PostgreSQL's unique-violation (23505) - two registrations racing for one session. */
function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof QueryFailedError &&
    (e.driverError as { code?: string } | undefined)?.code === '23505'
  );
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The server half of Android's Restore Credentials (WP-RESTORE-1, docs/wiki/account-restore.md):
 * it issues WebAuthn options, verifies what the phone's Credential Manager answers, and stores the
 * PUBLIC key of each restore key, bound to the session that registered it.
 *
 * It never mints a session itself - the controller does, through the same `issueSession` the
 * MiConnect callback uses - so a restored sign-in cannot drift from an ordinary one.
 */
@Injectable()
export class RestoreCredentialsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RestoreCredentialsService.name);
  private readonly config: RestoreConfig;
  private readonly challengeKey: Buffer;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(RestoreCredential)
    private readonly credentials: Repository<RestoreCredential>,
    @InjectRepository(RestoreChallengeSpent)
    private readonly spent: Repository<RestoreChallengeSpent>,
    @InjectRepository(AuthSession)
    private readonly sessions: Repository<AuthSession>,
    private readonly dataSource: DataSource,
    private readonly pushEnd: SessionPushEndService
  ) {
    // The controller refuses to start without JWT_SECRET; this is the same secret under its own
    // label, so an empty one throws here too rather than deriving a key anyone can compute.
    this.challengeKey = deriveRestoreChallengeKey(process.env.JWT_SECRET ?? '');
    this.config = readRestoreConfig(process.env.ANDROID_APP_LINK_SHA256, process.env.FRONTEND_URL);
    if (this.config.available) {
      this.logger.log(
        `[RESTORE] available: rpId=${this.config.rpId} origins=${this.config.origins.length}`
      );
    } else {
      // An estate that should offer restore and cannot is a deployment defect, so it accuses - once,
      // at boot, rather than once per refused phone.
      this.logger.error(
        `[RESTORE] UNAVAILABLE on this estate: ${this.config.reason} - every restore route answers 503`
      );
    }
  }

  onModuleInit(): void {
    void this.deleteExpiredSpent();
    this.sweepTimer = setInterval(() => void this.deleteExpiredSpent(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Whether this estate can verify a restore key at all (a fingerprint and an RP id are configured). */
  get available(): boolean {
    return this.config.available;
  }

  private requireConfig(): { rpId: string; origins: string[] } {
    if (!this.config.available) throw new Error(`restore unavailable: ${this.config.reason}`);
    return this.config;
  }

  /**
   * Whether `sessionId` is a LIVE session of `userId` - the same three conditions a refresh checks
   * (exists, belongs to the caller, not past `expiresAt`), because a key is worth no more than it.
   *
   * With `tokenId`, also that it is the session's CURRENT refresh id - or the one its last rotation
   * replaced, inside the SAME grace window a refresh grants ({@link isPreviousTokenInGrace}). A
   * registration demands it: a refresh credential the rotation has moved past is one somebody else
   * may hold, and accepting it would let a thief plant a key without ever rotating - so the fork
   * detection never fires. The grace token is accepted because a start runs its refresh and this
   * registration side by side, and a refresh already hands that token's holder the current one: the
   * window grants nothing the refresh does not.
   */
  async isLiveSessionOf(
    userId: string,
    sessionId: string,
    now: Date,
    tokenId?: string
  ): Promise<boolean> {
    const row = await this.sessions.findOne({
      where: { id: sessionId, userId },
      select: { id: true, expiresAt: true, tokenId: true, previousTokenId: true, rotatedAt: true },
    });
    if (!row || row.expiresAt.getTime() <= now.getTime()) return false;
    if (
      tokenId !== undefined &&
      row.tokenId !== tokenId &&
      !isPreviousTokenInGrace(row, tokenId, now)
    ) {
      this.logger.warn(
        `[RESTORE] sid=${sessionId} presented a refresh credential that is not its current one`
      );
      return false;
    }
    return true;
  }

  /** The credential id of the key `sessionId` holds now, or null. Read at every app start. */
  async registeredKeyOf(sessionId: string): Promise<string | null> {
    const row = await this.credentials.findOne({ where: { sessionId }, select: { id: true } });
    return row?.id ?? null;
  }

  /** Creation options for a restore key of THIS session (the challenge is bound to it). */
  async registrationOptions(
    sessionId: string,
    now: Date
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const { rpId } = this.requireConfig();
    const challenge = mintRestoreChallenge(this.challengeKey, 'register', sessionId, now);
    this.logger.debug(`[RESTORE] registration options issued sid=${sessionId}`);
    return generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rpId,
      // A random handle per key, never the account id: nothing in the user's backup names them.
      userID: randomBytes(32),
      userName: RP_NAME,
      userDisplayName: RP_NAME,
      // Bytes, not a string: the library base64url-encodes what it is given, and a string would be
      // encoded from its UTF-8 - the echoed challenge must be THIS value, byte for byte.
      challenge: Buffer.from(challenge, 'base64url'),
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'discouraged' },
      // ES256, RS256: what Android's platform authenticator offers.
      supportedAlgorithmIDs: [-7, -257],
    });
  }

  /**
   * Verifies a registration response and stores THE key of this session, replacing any earlier one.
   *
   * User presence and verification are not required: Credential Manager creates a restore key with
   * no prompt, which is the point of it (docs/wiki/account-restore.md, threat model).
   */
  async register(
    userId: string,
    sessionId: string,
    tokenId: string,
    response: RegistrationResponseJSON,
    cloudBackup: boolean,
    now: Date
  ): Promise<RegisterResult> {
    const { rpId, origins } = this.requireConfig();
    if (!(await this.isLiveSessionOf(userId, sessionId, now, tokenId))) {
      this.logger.warn(`[RESTORE] registration refused: no live session sid=${sessionId}`);
      return { status: 'no-session' };
    }
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: (c) => this.challengeHolds(c, 'register', sessionId, now) !== null,
        expectedOrigin: origins,
        expectedRPID: rpId,
        requireUserPresence: false,
        requireUserVerification: false,
        supportedAlgorithmIDs: [-7, -257],
      });
    } catch (e) {
      this.logger.warn(
        `[RESTORE] registration refused sid=${sessionId} id=${shortId(response?.id)}: ${errorText(e)}`
      );
      return { status: 'invalid', reason: errorText(e) };
    }
    if (!verification.verified) {
      this.logger.warn(`[RESTORE] registration refused sid=${sessionId}: not verified`);
      return { status: 'invalid', reason: 'not verified' };
    }
    const { credential } = verification.registrationInfo;
    const stored = await this.storeKey(userId, sessionId, credential, cloudBackup, now);
    if (stored === 'conflict') {
      this.logger.warn(
        `[RESTORE] registration refused sid=${sessionId}: another registration for this session committed first`
      );
      return { status: 'conflict' };
    }
    if (stored === 'taken') {
      this.logger.warn(
        `[RESTORE] registration refused sid=${sessionId}: key id=${shortId(credential.id)} is another session's`
      );
      return { status: 'taken' };
    }
    this.logger.log(
      `[RESTORE] key registered user=${userId} sid=${sessionId} id=${shortId(credential.id)} cloudBackup=${cloudBackup} replaced=${shortId(stored.replaced ?? undefined)}`
    );
    return { status: 'registered', credentialId: credential.id, replaced: stored.replaced };
  }

  /**
   * One transaction: the session's previous key goes and this one takes its place. A credential id
   * is CHOSEN BY THE CLIENT under `attestation: none`, so an id already bound to ANOTHER session is
   * refused rather than re-bound - re-binding would let one session take over another's key. Two
   * registrations racing for one session meet the unique constraint: the second is a typed
   * `conflict`, never a 500.
   */
  private async storeKey(
    userId: string,
    sessionId: string,
    credential: { id: string; publicKey: Uint8Array; counter: number },
    cloudBackup: boolean,
    now: Date
  ): Promise<'taken' | 'conflict' | { replaced: string | null }> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const existing = await manager.findOne(RestoreCredential, {
          where: { id: credential.id },
          select: { id: true, sessionId: true },
        });
        if (existing && existing.sessionId !== sessionId) return 'taken' as const;
        const previous = await manager.findOne(RestoreCredential, {
          where: { sessionId },
          select: { id: true },
        });
        await manager.delete(RestoreCredential, { sessionId });
        await manager.insert(RestoreCredential, {
          id: credential.id,
          userId,
          sessionId,
          publicKey: Buffer.from(credential.publicKey),
          counter: String(credential.counter),
          cloudBackup,
          createdAt: now,
        });
        return { replaced: previous && previous.id !== credential.id ? previous.id : null };
      });
    } catch (e) {
      if (isUniqueViolation(e)) return 'conflict';
      throw e;
    }
  }

  /** Request options for an anonymous restore. Writes nothing: the challenge carries its own proof. */
  async assertionOptions(now: Date): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const { rpId } = this.requireConfig();
    const challenge = mintRestoreChallenge(this.challengeKey, 'assert', '', now);
    return generateAuthenticationOptions({
      rpID: rpId,
      challenge: Buffer.from(challenge, 'base64url'),
      userVerification: 'discouraged',
      // Empty: the platform holds at most the keys of this app, and chooses.
      allowCredentials: [],
    });
  }

  /**
   * Verifies a restore assertion and WRITES NOTHING: the caller first applies the refusals a
   * sign-in owes (erasure, maintenance), which must leave the key usable, then calls
   * {@link consume}.
   *
   * `unknown` is answered before the signature is checked, so it tells a caller whether a credential
   * id exists. Harmless: an id is 16+ random bytes chosen by the platform, never listed anywhere.
   */
  async verifyAssertion(
    response: AuthenticationResponseJSON,
    now: Date
  ): Promise<VerifyAssertionResult> {
    const { rpId, origins } = this.requireConfig();
    const id = typeof response?.id === 'string' ? response.id : '';
    const row = id ? await this.credentials.findOne({ where: { id } }) : null;
    if (!row) {
      this.logger.warn(`[RESTORE] assertion refused: unknown key id=${shortId(id)}`);
      return { status: 'unknown' };
    }
    // The key's own session must still be live. A row whose session is past `expiresAt` but not
    // yet swept is refused here, exactly as its refresh would be.
    if (!(await this.isLiveSessionOf(row.userId, row.sessionId, now))) {
      this.logger.warn(
        `[RESTORE] assertion refused: the key's session is gone id=${shortId(id)} sid=${row.sessionId}`
      );
      return { status: 'unknown' };
    }

    let checked: CheckedChallenge | null = null;
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: (c) => {
          checked = this.challengeHolds(c, 'assert', '', now);
          return checked !== null;
        },
        expectedOrigin: origins,
        expectedRPID: rpId,
        credential: {
          id: row.id,
          publicKey: new Uint8Array(row.publicKey),
          counter: Number(row.counter),
        },
        // A restore key is used with no prompt: neither UP nor UV is set, by design.
        advancedFIDOConfig: { userVerification: 'discouraged' },
      });
    } catch (e) {
      this.logger.warn(`[RESTORE] assertion refused id=${shortId(id)}: ${errorText(e)}`);
      return { status: 'invalid', reason: errorText(e) };
    }
    const spentChallenge = checked as CheckedChallenge | null;
    if (!verification.verified || !spentChallenge) {
      this.logger.warn(`[RESTORE] assertion refused id=${shortId(id)}: not verified`);
      return { status: 'invalid', reason: 'not verified' };
    }

    return {
      status: 'verified',
      assertion: {
        userId: row.userId,
        credentialId: row.id,
        sessionId: row.sessionId,
        challenge: spentChallenge,
      },
    };
  }

  /**
   * Consumes a verified assertion: the challenge is SPENT, the key is DELETED and the session it was
   * bound to is REVOKED - its push ending recorded with it (cause `restored`) - in ONE transaction,
   * so a restore can never leave the account with one more session than before (the new phone's is
   * minted only after this commits), nor the old phone with the account's notifications.
   *
   * SINGLE USE, TWICE OVER, settled by the database: the challenge's nonce is recorded (a second
   * presentation of the same assertion finds it), and the key is consumed by `DELETE ... RETURNING`
   * (of two concurrent assertions with different challenges, exactly one deletes the row).
   */
  async consume(assertion: VerifiedAssertion): Promise<ConsumeResult> {
    const id = assertion.credentialId;
    const outcome = await this.dataSource.transaction(async (manager) => {
      const inserted: unknown[] = await manager.query(
        `INSERT INTO restore_challenges_spent (nonce, "expiresAt") VALUES ($1, $2)
         ON CONFLICT (nonce) DO NOTHING RETURNING nonce`,
        [assertion.challenge.nonce, assertion.challenge.expiresAt]
      );
      if (inserted.length === 0) return 'replay' as const;
      // TypeORM's postgres driver answers a raw DELETE (or UPDATE) as `[rows, rowCount]`, never as
      // the rows alone - an INSERT is answered with the rows. Destructured, as
      // `SessionPushEndService.claim` does.
      const [consumed] = (await manager.query(
        `DELETE FROM restore_credentials WHERE id = $1 RETURNING "sessionId"`,
        [id]
      )) as [{ sessionId: string }[], number];
      if (consumed.length === 0) return 'gone' as const;
      const sessionId = consumed[0].sessionId;
      // The old phone's session ends with the key, AND records its push ending in this same
      // transaction - what every session end in `AuthSessionsService` owes (docs/wiki/sessions.md,
      // "A session that ends takes its device's push registration with it"). Without it a phone
      // restored from and then sold keeps receiving the account's notifications. RETURNING, so the
      // ending names exactly the row THIS delete removed: a concurrent revocation that won the
      // delete has recorded the ending itself.
      const [ended] = (await manager.query(
        `DELETE FROM auth_sessions WHERE id = $1 RETURNING id, "userId", "deviceId"`,
        [sessionId]
      )) as [EndedSession[], number];
      const queued = await this.pushEnd.enqueue(manager, ended, 'restored');
      return { sessionId, queued };
    });
    if (outcome === 'replay') {
      this.logger.warn(
        `[RESTORE] assertion refused id=${shortId(id)}: challenge already spent (replay)`
      );
      return { status: 'invalid', reason: 'replay' };
    }
    if (outcome === 'gone') {
      // Another assertion consumed the key between the verification and this write.
      this.logger.warn(`[RESTORE] assertion refused id=${shortId(id)}: key consumed concurrently`);
      return { status: 'unknown' };
    }
    // Drained after the commit and unawaited, as `AuthSessionsService.endSessions` does: a slow
    // chat-delivery never turns a restore into a refusal, and the outbox row survives its failure.
    if (outcome.queued > 0) void this.pushEnd.drain();
    this.logger.log(
      `[RESTORE] key consumed and its session revoked user=${assertion.userId} id=${shortId(id)} sid=${outcome.sessionId} pushEndings=${outcome.queued}`
    );
    return { status: 'consumed' };
  }

  /** The challenge, when it verifies for this purpose and binding now; null otherwise (logged). */
  private challengeHolds(
    challenge: string,
    purpose: RestoreChallengePurpose,
    binding: string,
    now: Date
  ): CheckedChallenge | null {
    const result = checkRestoreChallenge(this.challengeKey, challenge, purpose, binding, now);
    if (result.ok) return result.challenge;
    this.logger.warn(`[RESTORE] ${purpose} challenge refused: ${result.refusal}`);
    return null;
  }

  /** Drops spent nonces past their expiry, after which the challenge is refused as expired anyway. */
  async deleteExpiredSpent(now: Date = new Date()): Promise<number> {
    try {
      const res = await this.spent.delete({ expiresAt: LessThan(now) });
      const removed = res.affected ?? 0;
      if (removed > 0) this.logger.debug(`[RESTORE] swept ${removed} spent challenge(s)`);
      return removed;
    } catch (e) {
      // Housekeeping must never take the service down (e.g. the table is not migrated yet).
      this.logger.warn(`[RESTORE] spent-challenge sweep failed: ${errorText(e)}`);
      return 0;
    }
  }
}
