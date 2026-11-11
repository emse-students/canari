import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { ECOSYSTEM_SITES } from './handoff-sites';
import {
  MiconnectReadError,
  MiconnectReaderClient,
  OPEN_FLOW_AUTHENTICATION,
  type MiconnectApplicationAccess,
} from './miconnect-reader.client';

/** Injection token of the access gate, so a test hands the mint a gate of its own. */
export const HANDOFF_ACCESS = Symbol('HANDOFF_ACCESS');

/**
 * Why a mint was refused at MiConnect's door - the class each refusal is logged with.
 *
 * `denied` kinds are MiConnect's (or the account's) answer: the person may not enter by OIDC either.
 * `unavailable` kinds mean the question could not be asked: the mint FAILS CLOSED, never open.
 */
export const HandoffAccessClass = {
  /** The Canari account holds no MiConnect uuid yet (not re-signed-in since WP3). */
  notLinked: 'not_linked',
  /** MiConnect knows no user with that uuid. */
  unknownAccount: 'unknown_miconnect_user',
  /** The MiConnect account is deactivated. */
  inactive: 'inactive',
  /** The uuid on the Canari account names a MiConnect user whose `uid` is not this account's id. */
  identityMismatch: 'identity_mismatch',
  /**
   * A policy is bound on the target application, on its provider's authentication or authorization
   * flow, or on a stage of them: only MiConnect could evaluate it, and it cannot be asked (section 9).
   */
  policyBound: 'policy_bound',
  /** The authorization flow asks more than a signed-in user (e.g. `require_superuser`). */
  flowRestricted: 'flow_restricted',
  /** The tenant's `core_default_app_access` is false: an unbound application lets nobody in. */
  defaultAccessOff: 'default_access_off',
  /** No reader token or MiConnect URL on this estate. */
  notConfigured: 'miconnect_not_configured',
  /** MiConnect gave no answer. */
  unreachable: 'miconnect_unreachable',
  /** MiConnect answered with a status the read did not expect (a lost permission, a 5xx). */
  refused: 'miconnect_refused',
} as const;

export type HandoffAccessClassCode = (typeof HandoffAccessClass)[keyof typeof HandoffAccessClass];

const UNAVAILABLE: ReadonlySet<HandoffAccessClassCode> = new Set([
  HandoffAccessClass.notConfigured,
  HandoffAccessClass.unreachable,
  HandoffAccessClass.refused,
]);

/** A refused mint at MiConnect's door, typed by its class. */
export class HandoffAccessRefused extends Error {
  constructor(
    readonly accessClass: HandoffAccessClassCode,
    readonly detail: string
  ) {
    super(`handoff access ${accessClass}: ${detail}`);
    this.name = 'HandoffAccessRefused';
  }

  /** True when the question could not be asked, false when MiConnect's answer was no. */
  get unavailable(): boolean {
    return UNAVAILABLE.has(this.accessClass);
  }
}

/** What the mint asks before it signs anything. */
export interface HandoffAccess {
  /** Resolves when MiConnect would let `userId` into `application`; throws {@link HandoffAccessRefused} otherwise. */
  assertMayEnter(userId: string, application: string): Promise<void>;
}

/**
 * F3-BOUND - MICONNECT STILL DECIDES WHO ENTERS A SITE CANARI SIGNS SOMEONE INTO (decided
 * 2026-11-11 by the lead under the owner's delegation; design section 9,
 * docs/wiki/backlog.d/sign-in-handoff-to-the-ecosystem-sites-and-migallery-notifications.md).
 *
 * authentik 2026.8's `check_access?for_user` honours `for_user` for a superuser only, so this reads
 * the INPUTS of its answer with a read-only account and answers exactly when they settle it: the
 * account is active, the application has no enabled policy binding, and `core_default_app_access`
 * is true (or unset - its default is true, `authentik/core/apps.py`). A bound application is
 * REFUSED (`policy_bound`), never evaluated here: copying MiConnect's policy logic into Canari is
 * what F2 was rejected for. Every MiConnect failure refuses too - a transport failure is not an
 * answer, and the mint never falls back to minting.
 *
 * At boot it also says, once per handoff application, whether a binding has appeared - the one
 * change that silently turns a site's handoff off ({@link onApplicationBootstrap}).
 */
@Injectable()
export class MiconnectHandoffAccess implements HandoffAccess, OnApplicationBootstrap {
  private readonly logger = new Logger('HandoffAccess');

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly reader: MiconnectReaderClient
  ) {}

  async assertMayEnter(userId: string, application: string): Promise<void> {
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, miconnectUuid: true },
    });
    const uuid = user?.miconnectUuid ?? null;
    if (!uuid) {
      throw new HandoffAccessRefused(
        HandoffAccessClass.notLinked,
        'no MiConnect uuid on the account'
      );
    }
    try {
      const [account, access] = await Promise.all([
        this.reader.findAccount(uuid),
        this.reader.applicationAccess(application),
      ]);
      if (!account) {
        throw new HandoffAccessRefused(
          HandoffAccessClass.unknownAccount,
          `uuid ${uuid.slice(0, 8)}`
        );
      }
      // The uuid link is trusted only when it leads back to THIS account: authentik's `uid` is the
      // OIDC `sub` Canari keyed the account by.
      if (account.uid !== userId) {
        throw new HandoffAccessRefused(HandoffAccessClass.identityMismatch, `pk ${account.pk}`);
      }
      if (!account.isActive) {
        throw new HandoffAccessRefused(HandoffAccessClass.inactive, `pk ${account.pk}`);
      }
      const closed = closedBy(access);
      if (closed) {
        throw new HandoffAccessRefused(closed, `app=${application} ${describe(access)}`);
      }
    } catch (e) {
      if (e instanceof MiconnectReadError) {
        const accessClass =
          e.failure === 'not_configured'
            ? HandoffAccessClass.notConfigured
            : e.failure === 'unreachable'
              ? HandoffAccessClass.unreachable
              : HandoffAccessClass.refused;
        throw new HandoffAccessRefused(accessClass, e.detail);
      }
      throw e;
    }
  }

  /**
   * THE WATCH: the handoff of a site turns OFF in silence the day MiConnect gains a policy binding
   * on its application. So each boot (every deploy) reads the three applications and says, at warn,
   * any that is bound - and at log that the others may mint. Not awaited: a slow MiConnect must not
   * hold the boot, and every outcome is logged.
   */
  onApplicationBootstrap(): void {
    void this.reportBindings();
  }

  /** Reads and logs each handoff application's access inputs. Never throws. */
  async reportBindings(): Promise<void> {
    if (!this.reader.config()) {
      this.logger.log(
        '[HANDOFF_ACCESS] MICONNECT_READER_TOKEN is unset - every handoff mint on this estate is refused miconnect_not_configured'
      );
      return;
    }
    for (const site of ECOSYSTEM_SITES) {
      if (!site.miconnectApplication) continue;
      try {
        const access = await this.reader.applicationAccess(site.miconnectApplication);
        const closed = closedBy(access);
        if (closed) {
          this.logger.warn(
            `[HANDOFF_ACCESS] site=${site.id} app=${site.miconnectApplication} ${describe(access)} ` +
              `- every handoff to it is REFUSED ${closed} until MiConnect can answer check_access for a non-superuser (design section 9)`
          );
        } else {
          this.logger.log(
            `[HANDOFF_ACCESS] site=${site.id} app=${site.miconnectApplication} ${describe(access)} ` +
              '- an active account may be handed off (not read: what a stage itself decides from a user, e.g. a group check inside an expression stage)'
          );
        }
      } catch (e) {
        this.logger.error(
          `[HANDOFF_ACCESS] site=${site.id} app=${site.miconnectApplication} could not be read: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  }
}

/** The class that closes an application to the handoff, or null when its inputs settle it open. */
function closedBy(access: MiconnectApplicationAccess): HandoffAccessClassCode | null {
  if (access.enabledBindings > 0 || access.flowBindings > 0) return HandoffAccessClass.policyBound;
  if (!OPEN_FLOW_AUTHENTICATION.has(access.authorizationFlowAuthentication)) {
    return HandoffAccessClass.flowRestricted;
  }
  if (access.defaultAccessFlag === false) return HandoffAccessClass.defaultAccessOff;
  return null;
}

/** The inputs, as a log line names them. */
function describe(access: MiconnectApplicationAccess): string {
  return (
    `bindings=${access.enabledBindings} flow_bindings=${access.flowBindings} ` +
    `flow_auth=${access.authorizationFlowAuthentication} default_access=${access.defaultAccessFlag ?? 'unset'}`
  );
}
