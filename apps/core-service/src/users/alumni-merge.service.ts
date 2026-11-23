import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { DataSource } from 'typeorm';
import { AccountErasureService } from '../account-erasure/account-erasure.service';
import { chatDeliveryUrl, socialUrl } from '../internal/service-urls';
import { MiconnectEditorClient, type MiconnectUserListing } from './miconnect-editor.client';
import {
  AlumniMergeHoldingsUnavailableError,
  AlumniMergeNoMatchError,
  AlumniMergeNotDuplicateError,
  AlumniMergeNotFoundError,
} from './alumni-merge.errors';

/** The username every account an Alumni sign-in CREATED carries (D46: `alumni-<af_id>`). */
export const ALUMNI_USERNAME_PREFIX = 'alumni-';
/** The slug of the Alumni SAML source (`30-sources.yaml`); never renamed, it is in two URLs. */
export const ALUMNI_SOURCE_SLUG = 'alumni';

/** How long one internal count may take before the holdings count as unknown. */
const HOLDINGS_TIMEOUT_MS = 5_000;

/** One MiConnect account as the admin's duplicates list shows it. */
export interface AlumniAccount {
  uuid: string;
  username: string;
  name: string;
  /** The entry years of its cursus (`attributes.profile.cursus[].promo`). */
  promos: number[];
  /** The Canari account it signed in as, or null when it never did. */
  canariUserId: string | null;
}

/** A flagged duplicate (D47) and the accounts it matches. */
export interface AlumniDuplicate {
  duplicate: AlumniAccount;
  targets: AlumniAccount[];
}

/**
 * What a duplicate holds in Canari, as counts the erasure would take (D48). `canariAccount: false`
 * when it never signed in to Canari: every count is then 0, and nothing is erased.
 */
export interface AlumniHoldings {
  canariAccount: boolean;
  personalPosts: number;
  associations: number;
  communities: number;
  formSubmissions: number;
  conversations: number;
}

const NOTHING_HELD: AlumniHoldings = {
  canariAccount: false,
  personalPosts: 0,
  associations: 0,
  communities: 0,
  formSubmissions: 0,
  conversations: 0,
};

/**
 * A person's name as the duplicate check compares it: accents, case, hyphens and repeated spaces
 * folded. The CAS and Alumnforce spell one person differently ("Jean-Marie DUPONT" against
 * "Jean Marie Dupont"), and a miss here is a duplicate nobody is shown.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s\-']+/g, ' ')
    .trim();
}

/** The entry years an authentik user's profile names (D11), the malformed entries ignored. */
export function promosOf(attributes: Record<string, unknown>): number[] {
  const profile = attributes.profile as { cursus?: unknown } | undefined;
  const cursus = Array.isArray(profile?.cursus) ? (profile.cursus as unknown[]) : [];
  const promos = cursus
    .map((e) => (e as { promo?: unknown } | null)?.promo)
    .filter((p): p is number => Number.isInteger(p));
  return [...new Set(promos)];
}

/** Whether two accounts are the same person by D47's rule: the same name and a promo in common. */
export function sameNameAndPromo(
  a: { name: string; promos: number[] },
  b: { name: string; promos: number[] }
): boolean {
  return (
    normalizeName(a.name) !== '' &&
    normalizeName(a.name) === normalizeName(b.name) &&
    a.promos.some((p) => b.promos.includes(p))
  );
}

/** Whether an authentik account was created by an Alumni sign-in (D46). */
function isAlumniCreated(user: { username: string }): boolean {
  return user.username.startsWith(ALUMNI_USERNAME_PREFIX);
}

/** A person's account, never a service account (the editor itself, the handoff reader...). */
function isPersonAccount(user: { type: string }): boolean {
  return user.type === 'internal' || user.type === 'external';
}

/**
 * THE ALUMNI DUPLICATES AND THEIR MERGE (D47, D48), through the profile editor's MiConnect account.
 *
 * A person who signs in through Alumni before linking may create a second MiConnect account
 * (`alumni-<af_id>`). The admins see such an account when its name and promo match an existing one,
 * and "Rattacher" ends it: the duplicate is DELETED at MiConnect - its Alumni identity goes with it,
 * free to be linked onto the person's real account from MiConnect's settings page - and its Canari
 * account is erased through the account-erasure queue, the one path that erases an account.
 *
 * WHY THE LINK IS NOT MOVED. authentik's API serves a source connection's `user` READ-ONLY (2026.8:
 * `UserSourceConnectionSerializer`), so no token can re-point a link; and while the duplicate holds
 * the Alumni identity, a linking attempt from the real account signs the person INTO the duplicate
 * (`SourceFlowManager.get_action`: an existing connection is an `AUTH`). Deleting the duplicate first
 * is what makes the re-link possible at all; the reminder banner (D44) then asks for it.
 *
 * PRINCIPLE 2 ("the essential is never lost", docs/principes.md) is touched, knowingly: the owner
 * chose deletion over deactivation (2026-11-23). What answers it is that the admin confirms after
 * being SHOWN what the duplicate holds ({@link holdings}), and that the merge is traced.
 *
 * THE DESTRUCTIVE CONTROL HAS AN ALLOWLIST: it deletes an account only if its username starts with
 * `alumni-`, it holds no link but the Alumni one, and the target is a different, non-Alumni account
 * matching it by name and promo - each re-read from MiConnect at the moment of the merge.
 */
@Injectable()
export class AlumniMergeService {
  private readonly logger = new Logger(AlumniMergeService.name);
  private readonly internalSecret = process.env.INTERNAL_SECRET ?? '';

  constructor(
    private readonly dataSource: DataSource,
    private readonly editor: MiconnectEditorClient,
    private readonly accountErasure: AccountErasureService
  ) {}

  /** Every Alumni-created account that matches an existing account by name and promo (D47). */
  async listDuplicates(): Promise<AlumniDuplicate[]> {
    this.logger.log('[ALUMNI_MERGE] listing the duplicates');
    const alumni = (await this.editor.searchUsers(ALUMNI_USERNAME_PREFIX)).filter(
      (u) => isAlumniCreated(u) && isPersonAccount(u)
    );
    const found: { duplicate: MiconnectUserListing; targets: MiconnectUserListing[] }[] = [];
    for (const dup of alumni) {
      const dupKey = { name: dup.name, promos: promosOf(dup.attributes) };
      if (dupKey.promos.length === 0 || normalizeName(dup.name) === '') continue;
      const targets = (await this.editor.searchUsers(dup.name)).filter(
        (t) =>
          t.uuid !== dup.uuid &&
          !isAlumniCreated(t) &&
          isPersonAccount(t) &&
          sameNameAndPromo(dupKey, { name: t.name, promos: promosOf(t.attributes) })
      );
      if (targets.length > 0) found.push({ duplicate: dup, targets });
    }
    const canariIds = await this.canariIdsOf(
      found.flatMap((f) => [f.duplicate.uuid, ...f.targets.map((t) => t.uuid)])
    );
    const view = (u: MiconnectUserListing): AlumniAccount => ({
      uuid: u.uuid,
      username: u.username,
      name: u.name,
      promos: promosOf(u.attributes),
      canariUserId: canariIds.get(u.uuid) ?? null,
    });
    this.logger.log(
      `[ALUMNI_MERGE] ${alumni.length} Alumni-created account(s), ${found.length} flagged`
    );
    return found.map((f) => ({ duplicate: view(f.duplicate), targets: f.targets.map(view) }));
  }

  /**
   * What the duplicate's Canari account holds, counted by the services that hold it. A service that
   * does not answer refuses the whole reading ({@link AlumniMergeHoldingsUnavailableError}): the
   * admin is never shown a partial count as if it were the whole.
   */
  async holdings(duplicateUuid: string): Promise<AlumniHoldings> {
    this.editor.assertAvailable();
    const userId = (await this.canariIdsOf([duplicateUuid])).get(duplicateUuid);
    if (!userId) {
      this.logger.log(`[ALUMNI_MERGE] ${duplicateUuid.slice(0, 8)} has no Canari account`);
      return NOTHING_HELD;
    }
    const headers = { 'X-Internal-Secret': this.internalSecret };
    const path = `internal/users/${encodeURIComponent(userId)}/holdings`;
    const read = async <T>(service: string, url: string): Promise<T> => {
      try {
        return (await axios.get<T>(url, { headers, timeout: HOLDINGS_TIMEOUT_MS })).data;
      } catch (err) {
        this.logger.error(
          `[ALUMNI_MERGE] ${service} did not count what ${userId.slice(0, 8)} holds: ${String(err)}`
        );
        throw new AlumniMergeHoldingsUnavailableError(service);
      }
    };
    const [social, chat] = await Promise.all([
      read<Omit<AlumniHoldings, 'canariAccount' | 'conversations'>>('social', socialUrl(path)),
      read<{ conversations: number }>('chat-delivery', chatDeliveryUrl(path)),
    ]);
    return {
      canariAccount: true,
      personalPosts: social.personalPosts,
      associations: social.associations,
      communities: social.communities,
      formSubmissions: social.formSubmissions,
      conversations: chat.conversations,
    };
  }

  /**
   * "Rattacher" (D48): deletes the duplicate at MiConnect and erases its Canari account, on behalf of
   * `actorId`, traced in `alumni_merges`.
   *
   * THE ORDER IS THE DESIGN, AND THE TRACE ROW IS ITS DURABLE STATE. The row is written before the
   * deletion at MiConnect and completed after the erasure is recorded; a merge that stopped between
   * the two (MiConnect deleted, Canari not yet) is found by its pending row and RESUMED by the same
   * call - the duplicate is then gone from MiConnect, and only the erasure is left to record, which
   * is itself idempotent. A duplicate that is gone with no pending row was never merged here: 404.
   */
  async merge(
    duplicateUuid: string,
    targetUuid: string,
    actorId: string
  ): Promise<{ held: AlumniHoldings; resumed: boolean }> {
    const tag = `dup=${duplicateUuid.slice(0, 8)} target=${targetUuid.slice(0, 8)} actor=${actorId.slice(0, 8)}`;
    this.logger.log(`[ALUMNI_MERGE] requested ${tag}`);
    this.editor.assertAvailable();

    const [pending] = (await this.dataSource.query(
      `SELECT "targetUuid", held FROM alumni_merges
        WHERE "duplicateUuid" = $1 AND "completedAt" IS NULL`,
      [duplicateUuid]
    )) as { targetUuid: string; held: AlumniHoldings }[];
    if (pending && pending.targetUuid !== targetUuid) {
      this.logger.warn(`[ALUMNI_MERGE] refused ${tag}: pending into another account`);
      throw new AlumniMergeNoMatchError(
        'a merge of this duplicate into another account is pending'
      );
    }

    const [dup] = await this.editor.usersByUuid(duplicateUuid);
    let held: AlumniHoldings;
    if (!dup) {
      if (!pending) {
        this.logger.warn(`[ALUMNI_MERGE] refused ${tag}: no such account, nothing pending`);
        throw new AlumniMergeNotFoundError();
      }
      this.logger.log(`[ALUMNI_MERGE] resuming ${tag}: MiConnect already deleted it`);
      held = pending.held;
    } else {
      await this.assertMergeable(dup, duplicateUuid, targetUuid, tag);
      if (pending) {
        held = pending.held;
      } else {
        held = await this.holdings(duplicateUuid);
        const targetUserId = (await this.canariIdsOf([targetUuid])).get(targetUuid) ?? null;
        await this.dataSource.query(
          `INSERT INTO alumni_merges
             ("actorId", "duplicateUuid", "duplicateUsername", "targetUuid", "targetUserId", held)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT ("duplicateUuid") WHERE "completedAt" IS NULL DO NOTHING`,
          [actorId, duplicateUuid, dup.username, targetUuid, targetUserId, JSON.stringify(held)]
        );
      }
      await this.editor.deleteUser(dup.pk);
      this.logger.log(`[ALUMNI_MERGE] MiConnect account deleted ${tag}`);
    }

    const duplicateUserId = (await this.canariIdsOf([duplicateUuid])).get(duplicateUuid);
    if (duplicateUserId) {
      await this.accountErasure.requestErasure(duplicateUserId);
    } else {
      this.logger.log(`[ALUMNI_MERGE] ${tag}: no Canari account left to erase`);
    }
    await this.dataSource.query(
      `UPDATE alumni_merges SET "completedAt" = now()
        WHERE "duplicateUuid" = $1 AND "completedAt" IS NULL`,
      [duplicateUuid]
    );
    this.logger.log(`[ALUMNI_MERGE] done ${tag} held=${JSON.stringify(held)}`);
    return { held, resumed: !dup };
  }

  /**
   * The allowlist of the deletion, re-read from MiConnect now: the duplicate was created by an
   * Alumni sign-in and holds no other link; the target is another, non-Alumni person account
   * matching it by name and promo.
   */
  private async assertMergeable(
    dup: MiconnectUserListing,
    duplicateUuid: string,
    targetUuid: string,
    tag: string
  ): Promise<void> {
    const refuse = (error: Error): never => {
      this.logger.warn(`[ALUMNI_MERGE] refused ${tag}: ${error.message}`);
      throw error;
    };
    if (!isAlumniCreated(dup) || !isPersonAccount(dup)) {
      refuse(new AlumniMergeNotDuplicateError('not created by an Alumni sign-in'));
    }
    const slugs = await this.editor.sourceSlugsOf(dup.pk);
    if (slugs.some((s) => s !== ALUMNI_SOURCE_SLUG)) {
      refuse(new AlumniMergeNotDuplicateError(`also linked to ${slugs.join(', ')}`));
    }
    if (targetUuid === duplicateUuid) refuse(new AlumniMergeNoMatchError('the same account'));
    const [target] = await this.editor.usersByUuid(targetUuid);
    if (!target) return refuse(new AlumniMergeNoMatchError('no such target account'));
    if (isAlumniCreated(target) || !isPersonAccount(target)) {
      refuse(new AlumniMergeNoMatchError('the target is not a CAS person account'));
    }
    const dupKey = { name: dup.name, promos: promosOf(dup.attributes) };
    if (!sameNameAndPromo(dupKey, { name: target.name, promos: promosOf(target.attributes) })) {
      refuse(new AlumniMergeNoMatchError('name and promo differ'));
    }
  }

  /** The Canari account of each MiConnect uuid that has one. */
  private async canariIdsOf(uuids: string[]): Promise<Map<string, string>> {
    if (uuids.length === 0) return new Map();
    const rows = (await this.dataSource.query(
      `SELECT id, "miconnectUuid" FROM users WHERE "miconnectUuid" = ANY($1)`,
      [uuids]
    )) as { id: string; miconnectUuid: string }[];
    return new Map(rows.map((r) => [r.miconnectUuid, r.id]));
  }
}
