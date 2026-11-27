import { Inject, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { DataSource } from 'typeorm';
import { AccountErasureService } from '../account-erasure/account-erasure.service';
import { chatDeliveryUrl, socialUrl } from '../internal/service-urls';
import { isDevEstate } from '../platform/deploy-build';
import { AlumniDuplicateQueue } from './alumni-duplicate-queue.service';
import { MiconnectEditorClient, type MiconnectUserListing } from './miconnect-editor.client';
import {
  AlumniMergeAlreadyMergedError,
  AlumniMergeHoldingsUnavailableError,
  AlumniMergeInProgressError,
  AlumniMergeNoMatchError,
  AlumniMergeNotDuplicateError,
  AlumniMergeNotFoundError,
} from './alumni-merge.errors';

/** The username every account an Alumni sign-in CREATED carries (D46: `alumni-<af_id>`). */
export const ALUMNI_USERNAME_PREFIX = 'alumni-';
/** The slug of the Alumni SAML source (`30-sources.yaml`); never renamed, it is in two URLs. */
export const ALUMNI_SOURCE_SLUG = 'alumni';

/**
 * The attributes of the MARK "Rattacher" writes on a duplicate. MiConnect reads the first at the
 * duplicate's next Alumni sign-in and merges (30-sources.yaml, `miconnect-alumni-merge-or-refuse`):
 * these names are a contract with that policy.
 */
export const MERGE_MARK = {
  into: 'alumni_merge_into',
  by: 'alumni_merge_marked_by',
  at: 'alumni_merge_marked_at',
} as const;

/** How long one internal count may take before the holdings count as unknown. */
const HOLDINGS_TIMEOUT_MS = 5_000;

/**
 * How long a merge may stay REQUESTED (its trace written, the mark or the erasure not yet recorded)
 * before the list calls it interrupted. "Rattacher" does both in one request, seconds apart; a row
 * still requested an hour later is a request that died between them, resumed by "Rattacher" again.
 */
const INTERRUPTED_AFTER_MS = 60 * 60 * 1000;

/** A MiConnect uuid; an erasure blanks a merge's target to a value that is not one. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One MiConnect account as the admin's duplicates list shows it. */
export interface AlumniAccount {
  uuid: string;
  username: string;
  name: string;
  /** Shown so an admin can tell two homonyms apart (the review of 2026-11-23). */
  email: string;
  /** ISO time of the last sign-in at MiConnect, null when it never signed in. */
  lastLogin: string | null;
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
 * An open merge, as the admin page lists it: REQUESTED (the trace written, the mark or the erasure
 * not recorded - an interrupted "Rattacher", resumed by the same action) or MARKED (waiting for the
 * duplicate's next Alumni sign-in, when MiConnect merges it). Either can be cancelled.
 */
export interface AlumniOpenMerge {
  duplicateUuid: string;
  duplicateUsername: string;
  targetUuid: string;
  status: 'requested' | 'marked';
  requestedAt: string;
  markedAt: string | null;
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

/** An `alumni_merges` row that is neither completed nor cancelled. */
interface OpenRow {
  id: string;
  duplicateUuid: string;
  duplicateUsername: string;
  targetUuid: string;
  held: AlumniHoldings;
  requestedAt: Date;
  markedAt: Date | null;
}

/** Letters NFKD does not decompose, spelled out; and the typographic apostrophe as the plain one. */
const LIGATURES: Record<string, string> = {
  '\u0153': 'oe',
  '\u0152': 'oe',
  '\u00e6': 'ae',
  '\u00c6': 'ae',
  '\u00df': 'ss',
  '\u2019': "'",
};

/**
 * A person's name as the duplicate check compares it: ligatures spelled out, accents and case
 * folded, the typographic apostrophe made plain, and hyphens, dots, apostrophes and spaces to one
 * space. The CAS and Alumnforce spell one person differently ("Jean-Marie DUPONT" against
 * "Jean Marie Dupont"), and a miss here is a duplicate nobody is shown. MiConnect's merge policy
 * (30-sources.yaml, `folded`) is the SAME function, step for step: change both together.
 */
export function normalizeName(name: string): string {
  return [...name]
    .map((c) => LIGATURES[c] ?? c)
    .join('')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s\-'.]+/g, ' ')
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

/** The write that removes the merge mark: each of its keys set to null, which MiConnect deletes. */
const MARK_REMOVED: Record<string, null> = Object.fromEntries(
  Object.values(MERGE_MARK).map((key) => [key, null])
);

/**
 * THE ALUMNI DUPLICATES AND THEIR MERGE (D47, D48), through the profile editor's MiConnect account.
 *
 * A person who signs in through Alumni before linking may create a second MiConnect account
 * (`alumni-<af_id>`). The admins see such an account when its name and promo match exactly ONE
 * existing account - both SELF-DECLARED, which is why MiConnect checks more before it moves anything -
 * and "Rattacher" MARKS it: `attributes.alumni_merge_into` names that account, with who marked it and
 * when. MiConnect does the merge itself at the duplicate's next Alumni sign-in - after checking that
 * the target holds a CAS link and carries the name Alumnforce asserts then, the Alumni link moved onto
 * it and the duplicate deleted in one transaction, the person signed in as the target
 * (30-sources.yaml). Only THEN is the duplicate's Canari account erased, through the account-erasure
 * queue, the one path that erases an account ({@link complete}). The editor token can only mark.
 *
 * WHY MiConnect DOES IT. authentik's API serves a source connection's `user` READ-ONLY, so no token
 * can re-point a link, and while the duplicate holds the Alumni identity a linking attempt from the
 * real account signs the person INTO the duplicate (`SourceFlowManager.get_action`). Only authentik
 * itself can move the link, and the sign-in is where it holds the duplicate in hand.
 *
 * PRINCIPLE 2 ("the essential is never lost", docs/principes.md): the person keeps their Alumni
 * identity, now on their real account, and nothing is deleted at MiConnect until that move succeeds.
 * The admin confirms after being SHOWN what the duplicate's Canari account holds ({@link holdings}).
 *
 * THE MARK HAS AN ALLOWLIST, re-read from MiConnect at the moment of the mark and AGAIN by MiConnect
 * at the merge: the duplicate was created by an Alumni sign-in and its links are exactly ['alumni'];
 * the target is the ONE other, non-Alumni, active person account matching it by name and promo, and
 * holds no Alumni link yet.
 *
 * THE TRACE (`alumni_merges`) IS THE DURABLE STATE: written REQUESTED before the mark, MARKED once
 * the mark is written, COMPLETED when the list sees the duplicate gone from MiConnect (the duplicate's
 * Canari account is erased then), or CANCELLED (closed too: `cancelledAt` and `completedAt`). One
 * open row per duplicate (migration 028's partial unique index on `"completedAt" IS NULL`), so two
 * concurrent "Rattacher" cannot both proceed.
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

  /**
   * The Alumni duplicates' admin queue, which learns of a duplicate's finding and of its mark. A
   * PROPERTY dependency so a hand-built spec needs no new argument; Nest refuses to boot without it
   * (`alumni-duplicate-queue.wiring.spec`), so it is absent only in such a spec.
   */
  @Inject(AlumniDuplicateQueue) private readonly queue?: AlumniDuplicateQueue;

  /**
   * A Canari account was just created for MiConnect account `miconnectUuid` (its first sign-in): when
   * that account was created by an Alumni sign-in and matches an existing one, it is a duplicate
   * that waits for an admin, and the admins are told NOW, not when someone next opens the page
   * (`AlumniDuplicateQueue`). Production only, like every editor call: dev shares production
   * MiConnect, so a dev sign-in must neither read it nor tell production's admins. NEVER THROWS: the
   * sign-in does not wait on it, and a failure is logged at error - the page reading finds the
   * duplicate anyway.
   */
  async flagNewAccount(miconnectUuid: string): Promise<void> {
    if (isDevEstate()) return;
    const tag = miconnectUuid.slice(0, 8);
    try {
      const account = await this.editor.userByUuid(miconnectUuid);
      if (!account || !isAlumniCreated(account) || !isPersonAccount(account)) return;
      const targets = await this.targetsOf(account);
      if (targets.length === 0) {
        this.logger.log(`[ALUMNI_MERGE] new Alumni account ${tag} matches no existing account`);
        return;
      }
      await this.queue?.flag(account.uuid);
    } catch (err) {
      this.logger.error(
        `[ALUMNI_MERGE] the new account ${tag} was NOT checked for a duplicate: ${String(err)}`
      );
    }
  }

  /**
   * Every Alumni-created account that matches an existing account by name and promo (D47), but not
   * one already in an open merge: those are listed by {@link listOpenMerges}.
   */
  async listDuplicates(): Promise<AlumniDuplicate[]> {
    this.logger.log('[ALUMNI_MERGE] listing the duplicates');
    const open = new Set((await this.openRows()).map((r) => r.duplicateUuid));
    const alumni = (await this.editor.searchUsers(ALUMNI_USERNAME_PREFIX)).filter(
      (u) => isAlumniCreated(u) && isPersonAccount(u) && !open.has(u.uuid)
    );
    const found: { duplicate: MiconnectUserListing; targets: MiconnectUserListing[] }[] = [];
    for (const dup of alumni) {
      const targets = await this.targetsOf(dup);
      if (targets.length > 0) found.push({ duplicate: dup, targets });
    }
    const canariIds = await this.canariIdsOf(
      found.flatMap((f) => [f.duplicate.uuid, ...f.targets.map((t) => t.uuid)])
    );
    const view = (u: MiconnectUserListing): AlumniAccount => ({
      uuid: u.uuid,
      username: u.username,
      name: u.name,
      email: u.email ?? '',
      lastLogin: u.last_login ?? null,
      promos: promosOf(u.attributes),
      canariUserId: canariIds.get(u.uuid) ?? null,
    });
    this.logger.log(
      `[ALUMNI_MERGE] ${alumni.length} Alumni-created account(s), ${found.length} flagged`
    );
    return found.map((f) => ({ duplicate: view(f.duplicate), targets: f.targets.map(view) }));
  }

  /**
   * The open merges, each first reconciled with MiConnect: a duplicate MiConnect no longer has was
   * merged at its sign-in, and its row is COMPLETED here rather than listed. A row still REQUESTED
   * after {@link INTERRUPTED_AFTER_MS} is a "Rattacher" that died half-way: listed, and logged at error.
   */
  async listOpenMerges(): Promise<AlumniOpenMerge[]> {
    this.editor.assertAvailable();
    const out: AlumniOpenMerge[] = [];
    for (const row of await this.openRows()) {
      const tag = `dup=${row.duplicateUuid.slice(0, 8)} target=${row.targetUuid.slice(0, 8)}`;
      if (!(await this.editor.userByUuid(row.duplicateUuid))) {
        await this.complete(row, tag);
        continue;
      }
      if (
        !row.markedAt &&
        Date.now() - new Date(row.requestedAt).getTime() > INTERRUPTED_AFTER_MS
      ) {
        this.logger.error(
          `[ALUMNI_MERGE] interrupted ${tag}: requested at ${new Date(row.requestedAt).toISOString()} ` +
            'and never marked - "Rattacher" again resumes it, "Annuler" drops it'
        );
      }
      out.push({
        duplicateUuid: row.duplicateUuid,
        duplicateUsername: row.duplicateUsername,
        targetUuid: row.targetUuid,
        status: row.markedAt ? 'marked' : 'requested',
        requestedAt: new Date(row.requestedAt).toISOString(),
        markedAt: row.markedAt ? new Date(row.markedAt).toISOString() : null,
      });
    }
    this.logger.log(`[ALUMNI_MERGE] ${out.length} open merge(s)`);
    return out;
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
   * "Rattacher" (D48): MARKS the duplicate at MiConnect for a merge into `targetUuid`, on behalf of
   * `actorId`, traced in `alumni_merges`. MiConnect merges at the duplicate's next Alumni sign-in, and
   * its Canari account is erased once that is seen ({@link complete}), never at the mark.
   *
   * THE ORDER IS THE DESIGN. The trace row is written first (REQUESTED); the INSERT that finds an
   * open row already there inserts nothing, and this call then stops ({@link
   * AlumniMergeInProgressError}) unless that row is this same merge, which it resumes. The mark is
   * idempotent, and the row turns MARKED only after it: a call that died in between is resumed by
   * calling again.
   */
  async merge(
    duplicateUuid: string,
    targetUuid: string,
    actorId: string
  ): Promise<{ held: AlumniHoldings; status: 'marked' }> {
    const tag = `dup=${duplicateUuid.slice(0, 8)} target=${targetUuid.slice(0, 8)} actor=${actorId.slice(0, 8)}`;
    this.logger.log(`[ALUMNI_MERGE] requested ${tag}`);
    this.editor.assertAvailable();

    let open = await this.openRow(duplicateUuid);
    if (open && open.targetUuid !== targetUuid) {
      this.logger.warn(`[ALUMNI_MERGE] refused ${tag}: open into another account`);
      throw new AlumniMergeNoMatchError('a merge of this duplicate into another account is open');
    }
    const dup = await this.editor.userByUuid(duplicateUuid);
    if (!dup) {
      if (open?.markedAt) {
        await this.complete(open, tag);
        throw new AlumniMergeAlreadyMergedError();
      }
      this.logger.warn(`[ALUMNI_MERGE] refused ${tag}: no such account`);
      throw new AlumniMergeNotFoundError();
    }
    await this.assertMergeable(dup, targetUuid, tag);

    if (!open) {
      const held = await this.holdings(duplicateUuid);
      const targetUserId = (await this.canariIdsOf([targetUuid])).get(targetUuid) ?? null;
      const inserted = (await this.dataSource.query(
        `INSERT INTO alumni_merges
           ("actorId", "duplicateUuid", "duplicateUsername", "targetUuid", "targetUserId", held)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT ("duplicateUuid") WHERE "completedAt" IS NULL
         DO NOTHING
         RETURNING id`,
        [actorId, duplicateUuid, dup.username, targetUuid, targetUserId, JSON.stringify(held)]
      )) as { id: string }[];
      if (inserted.length !== 1) {
        this.logger.warn(`[ALUMNI_MERGE] refused ${tag}: another request opened it first`);
        throw new AlumniMergeInProgressError();
      }
      open = await this.openRow(duplicateUuid);
      if (!open) {
        this.logger.error(`[ALUMNI_MERGE] ${tag}: the row just inserted is not open`);
        throw new AlumniMergeInProgressError();
      }
    } else {
      this.logger.log(
        `[ALUMNI_MERGE] resuming ${tag}: its row is open, ${open.markedAt ? 'marked' : 'requested'}`
      );
    }

    // RE-READ JUST BEFORE THE WRITE: a duplicate gone since the holdings were counted is refused here,
    // typed. The write names the mark's keys only, and MiConnect merges them into the stored bag
    // under the account's row lock: no other key is written, and no edit by a writer taking that lock is lost.
    const fresh = await this.editor.userByUuid(duplicateUuid);
    if (!fresh) {
      this.logger.warn(
        `[ALUMNI_MERGE] refused ${tag}: the duplicate left MiConnect before its mark`
      );
      throw new AlumniMergeNotFoundError();
    }
    await this.editor.writeUser(fresh.uuid, {
      attributes: {
        [MERGE_MARK.into]: targetUuid,
        [MERGE_MARK.by]: actorId,
        [MERGE_MARK.at]: new Date().toISOString(),
      },
    });
    this.logger.log(`[ALUMNI_MERGE] marked at MiConnect ${tag}`);
    await this.dataSource.query(
      `UPDATE alumni_merges SET "markedAt" = COALESCE("markedAt", now()) WHERE id = $1`,
      [open.id]
    );
    this.logger.log(`[ALUMNI_MERGE] marked ${tag} held=${JSON.stringify(open.held)}`);
    // The duplicate left the admins' queue (a merge of it stands): every admin's badge recounts.
    await this.queue?.changed();
    return { held: open.held, status: 'marked' };
  }

  /**
   * "Annuler": removes the mark at MiConnect and closes the row CANCELLED. Too late once MiConnect
   * merged ({@link AlumniMergeAlreadyMergedError}, the row completed). Nothing was erased in Canari:
   * the erasure waits for the merge.
   */
  async cancel(duplicateUuid: string, actorId: string): Promise<void> {
    const tag = `dup=${duplicateUuid.slice(0, 8)} actor=${actorId.slice(0, 8)}`;
    this.logger.log(`[ALUMNI_MERGE] cancel requested ${tag}`);
    this.editor.assertAvailable();
    const open = await this.openRow(duplicateUuid);
    if (!open) {
      this.logger.warn(`[ALUMNI_MERGE] cancel refused ${tag}: no open merge`);
      throw new AlumniMergeNotFoundError();
    }
    const dup = await this.editor.userByUuid(duplicateUuid);
    if (!dup) {
      await this.complete(open, tag);
      throw new AlumniMergeAlreadyMergedError();
    }
    if (Object.values(MERGE_MARK).some((key) => key in dup.attributes)) {
      await this.editor.writeUser(dup.uuid, { attributes: MARK_REMOVED });
      this.logger.log(`[ALUMNI_MERGE] mark removed at MiConnect ${tag}`);
    }
    await this.dataSource.query(
      `UPDATE alumni_merges SET "cancelledAt" = now(), "cancelledBy" = $2, "completedAt" = now()
        WHERE id = $1 AND "completedAt" IS NULL`,
      [open.id, actorId]
    );
    this.logger.log(`[ALUMNI_MERGE] cancelled ${tag}`);
    // The duplicate waits again (a cancelled merge stands for nothing): every admin's badge recounts.
    await this.queue?.changed();
  }

  /**
   * The accounts `dup` matches: other, non-Alumni, active person accounts with the same name and a
   * promo in common. Read through authentik's search, a superset narrowed here.
   */
  private async targetsOf(dup: MiconnectUserListing): Promise<MiconnectUserListing[]> {
    const dupKey = { name: dup.name, promos: promosOf(dup.attributes) };
    if (dupKey.promos.length === 0 || normalizeName(dup.name) === '') return [];
    return (await this.editor.searchUsers(dup.name)).filter(
      (t) =>
        t.uuid !== dup.uuid &&
        !isAlumniCreated(t) &&
        isPersonAccount(t) &&
        t.is_active !== false &&
        sameNameAndPromo(dupKey, { name: t.name, promos: promosOf(t.attributes) })
    );
  }

  /**
   * The allowlist of the mark, re-read from MiConnect now: the duplicate was created by an Alumni
   * sign-in and its links are exactly ['alumni']; the target is the ONE account it matches (a
   * homonym makes the match ambiguous, and an ambiguous match is refused), and holds no Alumni link.
   */
  private async assertMergeable(
    dup: MiconnectUserListing,
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
    if (slugs.length !== 1 || slugs[0] !== ALUMNI_SOURCE_SLUG) {
      refuse(new AlumniMergeNotDuplicateError(`its links are [${slugs.join(', ')}], not [alumni]`));
    }
    if (targetUuid === dup.uuid) refuse(new AlumniMergeNoMatchError('the same account'));
    const target = await this.editor.userByUuid(targetUuid);
    if (!target) return refuse(new AlumniMergeNoMatchError('no such target account'));
    if (isAlumniCreated(target) || !isPersonAccount(target) || target.is_active === false) {
      refuse(new AlumniMergeNoMatchError('the target is not an active CAS person account'));
    }
    const matches = await this.targetsOf(dup);
    if (matches.length !== 1 || matches[0].uuid !== targetUuid) {
      refuse(
        new AlumniMergeNoMatchError(
          matches.length > 1
            ? `${matches.length} accounts match by name and promo`
            : 'name and promo differ'
        )
      );
    }
    if ((await this.editor.sourceSlugsOf(target.pk)).includes(ALUMNI_SOURCE_SLUG)) {
      refuse(new AlumniMergeNoMatchError('the target already holds an Alumni link'));
    }
  }

  /** The open row of a duplicate, or undefined. */
  private async openRow(duplicateUuid: string): Promise<OpenRow | undefined> {
    const [row] = (await this.dataSource.query(
      `SELECT id, "duplicateUuid", "duplicateUsername", "targetUuid", held, "requestedAt", "markedAt"
         FROM alumni_merges
        WHERE "duplicateUuid" = $1 AND "completedAt" IS NULL`,
      [duplicateUuid]
    )) as OpenRow[];
    return row;
  }

  /** Every open row, oldest first. */
  private async openRows(): Promise<OpenRow[]> {
    return (await this.dataSource.query(
      `SELECT id, "duplicateUuid", "duplicateUsername", "targetUuid", held, "requestedAt", "markedAt"
         FROM alumni_merges
        WHERE "completedAt" IS NULL
        ORDER BY "requestedAt"`
    )) as OpenRow[];
  }

  /**
   * Closes a row whose duplicate MiConnect no longer has. A MARKED row is the expected end: the
   * sign-in merged it, and the duplicate's Canari account is erased NOW, after the merge and never
   * before it (owner, 2026-11-24) - requested first, the row closed after, so a call that dies in
   * between finds the row still open and requests again (the erasure is idempotent). A duplicate
   * gone is not by itself proof of a merge: the erasure needs the TARGET to hold the Alumni link
   * now, read from MiConnect. A marked duplicate gone with the target holding no Alumni link went
   * some other way (deleted by hand in MiConnect's admin, or the target itself gone): logged at
   * error, nothing erased, the row closed. A REQUESTED one likewise erases nothing.
   *
   * Run when the admin list is read: the duplicate's Canari account is unusable from the merge on
   * (its MiConnect account is gone, so it can no longer sign in), and is erased at the next reading.
   */
  private async complete(row: OpenRow, tag: string): Promise<void> {
    const merged = row.markedAt
      ? await this.targetHoldsTheAlumniLink(row.targetUuid, row.duplicateUsername)
      : false;
    if (merged) {
      const duplicateUserId = (await this.canariIdsOf([row.duplicateUuid])).get(row.duplicateUuid);
      if (duplicateUserId) {
        await this.accountErasure.requestErasure(duplicateUserId);
      } else {
        this.logger.log(`[ALUMNI_MERGE] ${tag}: no Canari account to erase`);
      }
    }
    await this.dataSource.query(
      `UPDATE alumni_merges SET "completedAt" = now() WHERE id = $1 AND "completedAt" IS NULL`,
      [row.id]
    );
    if (merged) {
      this.logger.log(`[ALUMNI_MERGE] completed ${tag}: MiConnect merged it at its sign-in`);
    } else if (row.markedAt) {
      this.logger.error(
        `[ALUMNI_MERGE] completed ${tag}: the marked duplicate left MiConnect but the target holds ` +
          'not its Alumni link - not a merge, nothing erased in Canari'
      );
    } else {
      this.logger.warn(
        `[ALUMNI_MERGE] completed ${tag}: the duplicate left MiConnect before it was marked`
      );
    }
  }

  /**
   * Whether the merge's target holds, at MiConnect now, THE DUPLICATE'S Alumni link - the one fact
   * that proves the sign-in merged that duplicate into it: an Alumni connection whose identifier is
   * the `af_id` of the duplicate's username (`alumni-<af_id>`). A target blanked by an erasure (not a
   * uuid) or gone holds none.
   */
  private async targetHoldsTheAlumniLink(
    targetUuid: string,
    duplicateUsername: string
  ): Promise<boolean> {
    if (!UUID_SHAPE.test(targetUuid) || !duplicateUsername.startsWith(ALUMNI_USERNAME_PREFIX)) {
      return false;
    }
    const afId = duplicateUsername.slice(ALUMNI_USERNAME_PREFIX.length);
    const target = await this.editor.userByUuid(targetUuid);
    if (!target) return false;
    return (await this.editor.sourceLinksOf(target.pk)).some(
      (link) => link.slug === ALUMNI_SOURCE_SLUG && link.identifier === afId
    );
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
