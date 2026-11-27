import { Inject, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { DataSource } from 'typeorm';
import { AccountErasureService } from '../account-erasure/account-erasure.service';
import { DELETED_ACCOUNT } from '../account-erasure/erasure-policy';
import { chatDeliveryUrl, socialUrl } from '../internal/service-urls';
import { isDevEstate } from '../platform/deploy-build';
import { AlumniDuplicateQueue } from './alumni-duplicate-queue.service';
import { MiconnectEditorClient, type MiconnectUserListing } from './miconnect-editor.client';
import {
  AlumniMergeSiteJobsService,
  type AlumniMergeSiteState,
} from './alumni-merge-site-jobs.service';
import {
  ALUMNI_MERGE_REASON_MAX,
  ALUMNI_MERGE_REASON_MIN,
  AlumniMergeAlreadyMergedError,
  AlumniMergeHoldingsUnavailableError,
  AlumniMergeInProgressError,
  AlumniMergeNoMatchError,
  AlumniMergeNotDuplicateError,
  AlumniMergeNotFoundError,
  AlumniMergeNotMergedError,
  AlumniMergeReasonRequiredError,
  AlumniMergeTargetBusyError,
} from './alumni-merge.errors';

/** The username every account an Alumni sign-in CREATED carries (D46: `alumni-<af_id>`). */
export const ALUMNI_USERNAME_PREFIX = 'alumni-';
/** The slug of the Alumni SAML source (`30-sources.yaml`); never renamed, it is in two URLs. */
export const ALUMNI_SOURCE_SLUG = 'alumni';
/** The slug of the School's CAS source (`30-sources.yaml`): a merge target holds this link (D55). */
export const CAS_SOURCE_SLUG = 'cas-emse';

/**
 * The attributes of the MARK "Rattacher" writes on a duplicate. MiConnect reads them at the
 * duplicate's next Alumni sign-in and merges (30-sources.yaml, `miconnect-alumni-merge-or-refuse`),
 * and its write flow allowlists exactly these (80-profile-editor.yaml): these names are a contract
 * with both. The last four are D55's: the mode, this row's id, and for a manual mark the two names
 * the admin saw, which the policy compares again at the sign-in.
 */
export const MERGE_MARK = {
  into: 'alumni_merge_into',
  by: 'alumni_merge_marked_by',
  at: 'alumni_merge_marked_at',
  mode: 'alumni_merge_mode',
  id: 'alumni_merge_id',
  seenAlumniName: 'alumni_merge_seen_alumni_name',
  seenTargetName: 'alumni_merge_seen_target_name',
} as const;

/** How long one internal count may take before the holdings count as unknown. */
const HOLDINGS_TIMEOUT_MS = 5_000;

/**
 * How long a merge may stay REQUESTED (its trace written, the mark or the erasure not yet recorded)
 * before the list calls it interrupted. "Rattacher" does both in one request, seconds apart; a row
 * still requested an hour later is a request that died between them, resumed by "Rattacher" again.
 */
const INTERRUPTED_AFTER_MS = 60 * 60 * 1000;

/** How many closed merges the admin page lists, newest first. */
const CLOSED_LISTED = 20;

/** The shortest name search the manual merge runs (D55): one letter matches half the estate. */
const TARGET_SEARCH_MIN = 2;
/** The most candidates one manual-merge search checks for eligibility (each costs a links read). */
const TARGET_SEARCH_MAX = 25;

/** A MiConnect uuid; an erasure blanks a merge's target to a value that is not one. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How a merge was decided: the unique name-and-promo match (D47), or the admin with a reason (D55). */
export type AlumniMergeMode = 'auto' | 'manual';

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
 * duplicate's next Alumni sign-in, when MiConnect merges it, for as long as it takes - D56). Either
 * can be cancelled.
 */
export interface AlumniOpenMerge {
  duplicateUuid: string;
  duplicateUsername: string;
  targetUuid: string;
  status: 'requested' | 'marked';
  mode: AlumniMergeMode;
  reason: string | null;
  requestedAt: string;
  markedAt: string | null;
}

/** A closed merge (completed, not cancelled), with what each sibling site did with it (D54). */
export interface AlumniClosedMerge {
  id: string;
  duplicateUsername: string;
  targetUuid: string;
  mode: AlumniMergeMode;
  reason: string | null;
  completedAt: string;
  completedBy: 'push' | 'reconciler' | null;
  sites: AlumniMergeSiteState[];
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
  /** The admin who marked it last: a resume by another admin records that admin (D55). */
  actorId: string;
  duplicateUuid: string;
  duplicateUsername: string;
  targetUuid: string;
  held: AlumniHoldings;
  requestedAt: Date;
  markedAt: Date | null;
  mode: AlumniMergeMode;
  reason: string | null;
  duplicateSubject: string | null;
  targetSubject: string | null;
}

/** The columns {@link OpenRow} is read with. */
const OPEN_ROW_COLUMNS = `id, "actorId", "duplicateUuid", "duplicateUsername", "targetUuid", held, "requestedAt",
       "markedAt", mode, reason, "duplicateSubject", "targetSubject"`;

/** Who closes a merge whose duplicate MiConnect no longer has (D54). */
type Completer = 'push' | 'reconciler';

/**
 * Both OIDC subjects as MiConnect's push names them (D54, 85-alumni-merge-push.yaml), read by the merge
 * policy while both accounts existed. Only used where the row has none (a mark written before 1.8.3
 * and never read again before its merge); a row's own subject, captured at the mark, always wins.
 */
export interface PushedSubjects {
  duplicateSubject?: string;
  targetSubject?: string;
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

/**
 * Resolves the duplicate's admin-queue flag (`alumni_duplicate_flags`, migration 031) when its merge
 * row CLOSES, run by `complete` in the SAME transaction as the closing UPDATE (`$1` = the closed
 * row's duplicate uuid, read from that UPDATE's RETURNING): every path that completes a merge - the
 * page's reconciler, MiConnect's push, a "Rattacher" resumed over a vanished duplicate - closes it
 * there, so the queue never depends on the row surviving (an erasure of the target deletes it).
 */
export const RESOLVE_DUPLICATE_FLAG_SQL = `UPDATE alumni_duplicate_flags SET "resolvedAt" = now()
   WHERE "resolvedAt" IS NULL AND "duplicateUuid"::text = $1`;

/**
 * THE ONE RULE of what an admin can act on (D48, D55), pure: the account was created by an Alumni
 * sign-in, is a person, and its links are exactly [alumni]. The mark refuses by it
 * (`assertDuplicateShaped`), and the admins' queue flags only what it accepts (`flagNewAccount`,
 * `isFlaggable`): since D55 a merge by hand needs no name match, so a homonym or a name spelled
 * differently IS actionable and is flagged - nothing is merged by itself. Null when accepted, else
 * the reason, in the words of {@link AlumniMergeNotDuplicateError}.
 */
export function duplicateShapeRefusal(
  user: { username: string; type: string },
  slugs: readonly string[]
): string | null {
  if (!isAlumniCreated(user) || !isPersonAccount(user)) return 'not created by an Alumni sign-in';
  if (slugs.length !== 1 || slugs[0] !== ALUMNI_SOURCE_SLUG) {
    return `its links are [${slugs.join(', ')}], not [alumni]`;
  }
  return null;
}

/** The write that removes the merge mark: each of its keys set to null, which MiConnect deletes. */
const MARK_REMOVED: Record<string, null> = Object.fromEntries(
  Object.values(MERGE_MARK).map((key) => [key, null])
);

/**
 * The admin's written reason (D55), trimmed, or null when none is owed and none was given. A MANUAL
 * merge requires one; a reason given in either mode must hold {@link ALUMNI_MERGE_REASON_MIN} to
 * {@link ALUMNI_MERGE_REASON_MAX} code points after trimming - the page counts the same way
 * (`libs/contracts/alumni-merge-reason.json`, asserted on both sides).
 */
export function checkMergeReason(reason: unknown, mode: AlumniMergeMode): string | null {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text === '') {
    if (mode === 'manual') throw new AlumniMergeReasonRequiredError('missing');
    return null;
  }
  const length = [...text].length;
  if (length < ALUMNI_MERGE_REASON_MIN) throw new AlumniMergeReasonRequiredError('too_short');
  if (length > ALUMNI_MERGE_REASON_MAX) throw new AlumniMergeReasonRequiredError('too_long');
  return text;
}

/**
 * Whether an account may be a merge's TARGET at all (D55, both modes), from what a listing says: a
 * person (internal or external), active, not a superuser, not itself created by an Alumni sign-in.
 * Its links (a CAS link, no Alumni link) are read separately.
 */
function isTargetShaped(user: MiconnectUserListing): boolean {
  return (
    !isAlumniCreated(user) &&
    isPersonAccount(user) &&
    user.is_active !== false &&
    user.is_superuser !== true
  );
}

/**
 * THE ALUMNI DUPLICATES AND THEIR MERGE (D47, D48, extended by D52-D58), through the profile
 * editor's MiConnect account.
 *
 * A person who signs in through Alumni before linking may create a second MiConnect account
 * (`alumni-<af_id>`). The admins see such an account when its name and promo match exactly ONE
 * existing account (`auto`), or pick the target themselves with a written reason when the names
 * differ between the Alumni base and Canari (`manual`, D55). "Rattacher" MARKS the duplicate:
 * `attributes.alumni_merge_into` names the target, with who marked it, when, the mode, this row's id
 * and, for a manual mark, the two names the admin saw. MiConnect does the merge itself at the
 * duplicate's next Alumni sign-in - after checking that the target holds a CAS link and that the names
 * still are what they were (30-sources.yaml) - and PUSHES it here (D54, {@link completeFromPush}).
 * Only THEN is the duplicate's Canari account erased, through the account-erasure queue, and each
 * sibling site is owed the transfer of the duplicate's account there (D52, {@link
 * AlumniMergeSiteJobsService}). The editor token can only mark.
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
 * the target is an active person account, not a superuser, not `alumni-`, holding a CAS link and no
 * Alumni link, and no other open merge names it ({@link AlumniMergeTargetBusyError}).
 *
 * THE TRACE (`alumni_merges`) IS THE DURABLE STATE: written REQUESTED before the mark (with both
 * accounts' subjects, read while they exist), MARKED once the mark is written, COMPLETED when
 * MiConnect's push - or, for a push that was lost, the admin page's reading - finds the duplicate gone
 * from MiConnect, or CANCELLED (closed too). One open row per duplicate (migration 028's partial unique
 * index), so two concurrent "Rattacher" cannot both proceed.
 */
@Injectable()
export class AlumniMergeService {
  private readonly logger = new Logger(AlumniMergeService.name);
  private readonly internalSecret = process.env.INTERNAL_SECRET ?? '';

  constructor(
    private readonly dataSource: DataSource,
    private readonly editor: MiconnectEditorClient,
    private readonly accountErasure: AccountErasureService,
    private readonly siteJobs: AlumniMergeSiteJobsService
  ) {}

  /**
   * The Alumni duplicates' admin queue, which learns of a duplicate's finding and of its mark. A
   * PROPERTY dependency so a hand-built spec needs no new argument; Nest refuses to boot without it
   * (`alumni-duplicate-queue.wiring.spec`), so it is absent only in such a spec.
   */
  @Inject(AlumniDuplicateQueue) private readonly queue?: AlumniDuplicateQueue;

  /**
   * A Canari account was just created for MiConnect account `miconnectUuid` (its first sign-in): when
   * that account was created by an Alumni sign-in and holds only that link, it is a duplicate
   * that waits for an admin - a merge by hand (D55) needs no name match, so every duplicate-shaped account is one - and the admins are told NOW, not when someone next opens the page
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
      const refusal = duplicateShapeRefusal(account, await this.editor.sourceSlugsOf(account.pk));
      if (refusal) {
        this.logger.log(`[ALUMNI_MERGE] new Alumni account ${tag} is not flagged: ${refusal}`);
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
   * Every Alumni-created account not already in an open merge (those are listed by {@link
   * listOpenMerges}), each with the existing accounts it matches by name and promo (D47) - the
   * flagged duplicates first. One that matches none is listed too, with no target: the admin may
   * still attach it by hand when the names differ between the Alumni base and Canari (D55).
   */
  async listDuplicates(): Promise<AlumniDuplicate[]> {
    this.logger.log('[ALUMNI_MERGE] listing the duplicates');
    const open = new Set((await this.openRows()).map((r) => r.duplicateUuid));
    const alumni = (await this.editor.searchUsers(ALUMNI_USERNAME_PREFIX)).filter(
      (u) => isAlumniCreated(u) && isPersonAccount(u) && !open.has(u.uuid)
    );
    const flagged: { duplicate: MiconnectUserListing; targets: MiconnectUserListing[] }[] = [];
    const unpaired: { duplicate: MiconnectUserListing; targets: MiconnectUserListing[] }[] = [];
    for (const dup of alumni) {
      const targets = await this.targetsOf(dup);
      (targets.length > 0 ? flagged : unpaired).push({ duplicate: dup, targets });
    }
    const found = [...flagged, ...unpaired];
    const view = await this.viewer(
      found.flatMap((f) => [f.duplicate.uuid, ...f.targets.map((t) => t.uuid)])
    );
    this.logger.log(
      `[ALUMNI_MERGE] ${alumni.length} Alumni-created account(s), ${flagged.length} flagged`
    );
    return found.map((f) => ({ duplicate: view(f.duplicate), targets: f.targets.map(view) }));
  }

  /**
   * The accounts an admin may attach a duplicate to BY HAND (D55, "Rattacher à un autre compte"):
   * MiConnect's user search for `query`, narrowed to the ELIGIBLE targets - a person, active, not a
   * superuser, not `alumni-`, not the duplicate, holding a CAS link and no Alumni link, and named by
   * no other open merge. Each shown with what tells homonyms apart (username, promos, e-mail, last
   * sign-in). A query shorter than {@link TARGET_SEARCH_MIN} characters answers nothing.
   */
  async eligibleTargets(duplicateUuid: string, query: string): Promise<AlumniAccount[]> {
    const tag = `dup=${duplicateUuid.slice(0, 8)}`;
    this.editor.assertAvailable();
    const q = query.trim();
    if ([...q].length < TARGET_SEARCH_MIN) return [];
    const dup = await this.editor.userByUuid(duplicateUuid);
    if (!dup) {
      this.logger.warn(`[ALUMNI_MERGE] target search refused ${tag}: no such account`);
      throw new AlumniMergeNotFoundError();
    }
    // The search discloses e-mails and last sign-ins (register M1): only for a real Alumni duplicate,
    // never for any account a caller names.
    await this.assertDuplicateShaped(dup, `target search ${tag}`);
    const busy = new Set(
      (await this.openRows())
        .filter((r) => r.duplicateUuid !== duplicateUuid)
        .map((r) => r.targetUuid)
    );
    const candidates = (await this.editor.searchUsers(q))
      .filter((t) => t.uuid !== dup.uuid && isTargetShaped(t) && !busy.has(t.uuid))
      .slice(0, TARGET_SEARCH_MAX);
    const eligible: MiconnectUserListing[] = [];
    for (const t of candidates) {
      const slugs = await this.editor.sourceSlugsOf(t.pk);
      if (slugs.includes(CAS_SOURCE_SLUG) && !slugs.includes(ALUMNI_SOURCE_SLUG)) eligible.push(t);
    }
    this.logger.log(
      `[ALUMNI_MERGE] target search ${tag}: ${candidates.length} candidate(s), ${eligible.length} eligible`
    );
    const view = await this.viewer(eligible.map((t) => t.uuid));
    return eligible.map(view);
  }

  /**
   * The open merges, each first reconciled with MiConnect - THE RECONCILER of a push that was lost
   * (D54): a duplicate MiConnect no longer has was merged at its sign-in, and its row is COMPLETED here
   * rather than listed, said at warning. An open row whose subjects were never captured (written
   * before 1.8.3) gets them now, while the duplicate exists. A row still REQUESTED after {@link
   * INTERRUPTED_AFTER_MS} is a "Rattacher" that died half-way: listed, and logged at error.
   */
  async listOpenMerges(): Promise<AlumniOpenMerge[]> {
    this.editor.assertAvailable();
    const out: AlumniOpenMerge[] = [];
    for (const row of await this.openRows()) {
      const tag = `dup=${row.duplicateUuid.slice(0, 8)} target=${row.targetUuid.slice(0, 8)}`;
      const dup = await this.editor.userByUuid(row.duplicateUuid);
      if (!dup) {
        await this.complete(row, tag, 'reconciler', await this.provenMerged(row));
        continue;
      }
      await this.captureSubjects(row, dup, tag);
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
        mode: row.mode,
        reason: row.reason,
        requestedAt: new Date(row.requestedAt).toISOString(),
        markedAt: row.markedAt ? new Date(row.markedAt).toISOString() : null,
      });
    }
    this.logger.log(`[ALUMNI_MERGE] ${out.length} open merge(s)`);
    return out;
  }

  /** The latest closed merges (completed, not cancelled), each with its three site states (D54). */
  async listClosedMerges(): Promise<AlumniClosedMerge[]> {
    const rows = (await this.dataSource.query(
      `SELECT id, "duplicateUsername", "targetUuid", mode, reason, "completedAt", "completedBy"
         FROM alumni_merges
        WHERE "completedAt" IS NOT NULL AND "cancelledAt" IS NULL
        ORDER BY "completedAt" DESC
        LIMIT $1`,
      [CLOSED_LISTED]
    )) as Array<{
      id: string;
      duplicateUsername: string;
      targetUuid: string;
      mode: AlumniMergeMode;
      reason: string | null;
      completedAt: Date;
      completedBy: Completer | null;
    }>;
    const sites = await this.siteJobs.statesOf(rows.map((r) => r.id));
    return rows.map((r) => ({
      id: r.id,
      duplicateUsername: r.duplicateUsername,
      targetUuid: r.targetUuid,
      mode: r.mode,
      reason: r.reason,
      completedAt: new Date(r.completedAt).toISOString(),
      completedBy: r.completedBy,
      sites: sites.get(r.id) ?? [],
    }));
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
   * "Rattacher" (D48, D55): see {@link markMerge}. Whatever it does - marked, refused, or failed
   * half-way - the admins' badges recount (`finally`): a requested row an interrupted call leaves
   * keeps the duplicate pending, and a mark that landed takes it out; the queue never waits on a later
   * reading.
   */
  async merge(
    duplicateUuid: string,
    targetUuid: string,
    actorId: string,
    reason?: unknown
  ): Promise<{ held: AlumniHoldings; status: 'marked'; mode: AlumniMergeMode }> {
    try {
      return await this.markMerge(duplicateUuid, targetUuid, actorId, reason);
    } finally {
      await this.queue?.changed();
    }
  }

  /**
   * "Rattacher" (D48, D55): MARKS the duplicate at MiConnect for a merge into `targetUuid`, on behalf
   * of `actorId`, traced in `alumni_merges`. The MODE is the server's to decide: `auto` when the
   * target is the duplicate's unique name-and-promo match, `manual` otherwise - and a manual merge
   * needs `reason` ({@link checkMergeReason}). MiConnect merges at the duplicate's next Alumni
   * sign-in, and its Canari account is erased once that is seen ({@link complete}), never at the mark.
   *
   * THE ORDER IS THE DESIGN. The trace row is written first (REQUESTED, with both accounts' subjects),
   * under the target's lock so no other open merge can name it meanwhile; the INSERT that finds an
   * open row already there inserts nothing, and this call then stops ({@link
   * AlumniMergeInProgressError}) unless that row is this same merge, which it resumes. The mark is
   * idempotent, and the row turns MARKED only after it: a call that died in between is resumed by
   * calling again.
   */
  private async markMerge(
    duplicateUuid: string,
    targetUuid: string,
    actorId: string,
    reason?: unknown
  ): Promise<{ held: AlumniHoldings; status: 'marked'; mode: AlumniMergeMode }> {
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
      // The proof decides, never `markedAt`: a request that died between the mark at MiConnect and
      // its `markedAt` is merged all the same once the target holds the duplicate's link.
      const merged = open ? await this.provenMerged(open) : false;
      if (open) await this.complete(open, tag, 'reconciler', merged);
      if (merged) throw new AlumniMergeAlreadyMergedError();
      this.logger.warn(`[ALUMNI_MERGE] refused ${tag}: no such account`);
      throw new AlumniMergeNotFoundError();
    }
    const { target, mode } = await this.assertMergeable(dup, targetUuid, tag);

    if (!open) {
      let text: string | null;
      try {
        text = checkMergeReason(reason, mode);
      } catch (err) {
        this.logger.warn(`[ALUMNI_MERGE] refused ${tag} mode=${mode}: ${(err as Error).message}`);
        throw err;
      }
      const held = await this.holdings(duplicateUuid);
      const targetUserId = (await this.canariIdsOf([targetUuid])).get(targetUuid) ?? null;
      const id = await this.openMerge(tag, {
        actorId,
        dup,
        target,
        targetUserId,
        held,
        mode,
        reason: text,
      });
      open = await this.openRow(duplicateUuid);
      if (!open || open.id !== id) {
        this.logger.error(`[ALUMNI_MERGE] ${tag}: the row just inserted is not open`);
        throw new AlumniMergeInProgressError();
      }
    } else {
      this.logger.log(
        `[ALUMNI_MERGE] resuming ${tag}: its row is open, ${open.markedAt ? 'marked' : 'requested'}`
      );
      // A RESUME KEEPS THE ROW'S MODE AND REASON: "Reprendre" sends no reason, and a manual row already
      // holds the one its admin wrote. An automatic row whose target is no longer the unique match
      // would otherwise be marked `auto` on an identity no admin vouched for: refused, as before D55 -
      // cancelled, it is attached again by hand, with a reason.
      if (open.mode === 'auto' && mode === 'manual') {
        this.logger.warn(
          `[ALUMNI_MERGE] refused ${tag}: an automatic merge whose target is no longer the unique match`
        );
        throw new AlumniMergeNoMatchError(
          'the target is no longer the unique name-and-promo match: cancel, then attach by hand'
        );
      }
      if (await this.targetBusy(targetUuid, duplicateUuid)) {
        this.logger.warn(`[ALUMNI_MERGE] refused ${tag}: another open merge names the target`);
        throw new AlumniMergeTargetBusyError();
      }
      await this.captureSubjects(open, dup, tag, target);
      if (open.actorId !== actorId) {
        // The mark below is this admin's (`alumni_merge_marked_by`), so the row is too; the admin who
        // opened it stays in this line.
        const earlier = open.actorId;
        await this.dataSource.query(
          `UPDATE alumni_merges SET "actorId" = $2 WHERE id = $1 AND "completedAt" IS NULL`,
          [open.id, actorId]
        );
        this.logger.log(
          `[ALUMNI_MERGE] resumed by another admin ${tag}: the row was opened by actor=${earlier.slice(0, 8)}`
        );
        open.actorId = actorId;
      }
    }

    // RE-READ JUST BEFORE THE WRITE: a duplicate gone since the holdings were counted is refused here,
    // typed. The write names the mark's keys only, and MiConnect merges them into the stored bag
    // under the account's row lock: no other key is written, and no edit by a writer taking that lock
    // is lost. The names of a manual mark are the ones read NOW, which is what the admin was shown
    // seconds ago; an automatic mark clears them, so a mark re-made in the other mode is whole.
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
        [MERGE_MARK.mode]: open.mode,
        [MERGE_MARK.id]: open.id,
        [MERGE_MARK.seenAlumniName]: open.mode === 'manual' ? fresh.name : null,
        [MERGE_MARK.seenTargetName]: open.mode === 'manual' ? target.name : null,
      },
    });
    this.logger.log(`[ALUMNI_MERGE] marked at MiConnect ${tag} mode=${open.mode}`);
    await this.dataSource.query(
      `UPDATE alumni_merges SET "markedAt" = COALESCE("markedAt", now()) WHERE id = $1`,
      [open.id]
    );
    this.logger.log(`[ALUMNI_MERGE] marked ${tag} held=${JSON.stringify(open.held)}`);
    return { held: open.held, status: 'marked', mode: open.mode };
  }

  /**
   * "Annuler": removes the mark at MiConnect and closes the row CANCELLED. Too late once MiConnect
   * merged ({@link AlumniMergeAlreadyMergedError}, the row completed). Nothing was erased in Canari:
   * the erasure waits for the merge. The duplicate is back in the person pickers (D56).
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
      await this.complete(open, tag, 'reconciler', await this.provenMerged(open));
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
   * MiConnect's PUSH of a merge it made at a sign-in (D54, `POST /api/hooks/miconnect/alumni-merge`,
   * 85-alumni-merge-push.yaml). The body is only a hint: the one open merge of that duplicate is
   * completed only if MiConnect, re-read NOW, no longer has the duplicate and the target holds the
   * duplicate's Alumni link - the same {@link complete} the page's reading runs. Anything else writes
   * nothing and is refused ({@link AlumniMergeNotMergedError}, at error): a forged call, even one with
   * the secret, can only make Canari look at the truth. No open merge of that duplicate (closed
   * already, or never asked for): `{ already: true }`, so a replayed push is a no-op. The push also
   * names both subjects ({@link PushedSubjects}), used only where the row captured none.
   */
  async completeFromPush(
    duplicateUuid: string,
    targetHint: string,
    mergeIdHint: string,
    pushed: PushedSubjects = {}
  ): Promise<{ completed: true } | { already: true }> {
    const tag = `dup=${duplicateUuid.slice(0, 8)} target=${targetHint.slice(0, 8)}`;
    this.logger.log(`[ALUMNI_MERGE] push received ${tag}`);
    this.editor.assertAvailable();
    const row = await this.openRow(duplicateUuid);
    if (!row) {
      this.logger.log(
        `[ALUMNI_MERGE] push ${tag}: no open merge of that duplicate - already closed`
      );
      return { already: true };
    }
    if (row.targetUuid !== targetHint || (mergeIdHint !== '' && mergeIdHint !== row.id)) {
      this.logger.warn(
        `[ALUMNI_MERGE] push ${tag}: its hint names target=${targetHint.slice(0, 8)} ` +
          `merge=${mergeIdHint.slice(0, 8) || '-'}, the open row target=${row.targetUuid.slice(0, 8)} ` +
          `merge=${row.id.slice(0, 8)} - MiConnect is read to decide`
      );
    }
    if (await this.editor.userByUuid(duplicateUuid)) {
      this.logger.error(
        `[ALUMNI_MERGE] push refused ${tag}: the duplicate still exists at MiConnect`
      );
      throw new AlumniMergeNotMergedError('the duplicate still exists');
    }
    if (!(await this.provenMerged(row))) {
      this.logger.error(
        `[ALUMNI_MERGE] push refused ${tag}: the target does not hold the duplicate's Alumni link`
      );
      throw new AlumniMergeNotMergedError("the target does not hold the duplicate's Alumni link");
    }
    await this.complete(row, tag, 'push', true, pushed);
    return { completed: true };
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
   * The allowlist of the mark, re-read from MiConnect now, and the MODE it decides: the duplicate was
   * created by an Alumni sign-in and its links are exactly ['alumni']; the target is another active
   * person account, not a superuser, not `alumni-`, holding a CAS link and no Alumni link (D55, both
   * modes). The mode is `auto` when the target is the duplicate's ONE name-and-promo match, `manual`
   * otherwise - a homonym or a name spelled differently in the Alumni base, decided by the admin.
   */
  private async assertMergeable(
    dup: MiconnectUserListing,
    targetUuid: string,
    tag: string
  ): Promise<{ target: MiconnectUserListing; mode: AlumniMergeMode }> {
    const refuse = (error: Error): never => {
      this.logger.warn(`[ALUMNI_MERGE] refused ${tag}: ${error.message}`);
      throw error;
    };
    await this.assertDuplicateShaped(dup, tag);
    if (targetUuid === dup.uuid) refuse(new AlumniMergeNoMatchError('the same account'));
    const target = await this.editor.userByUuid(targetUuid);
    if (!target) return refuse(new AlumniMergeNoMatchError('no such target account'));
    if (!isTargetShaped(target)) {
      refuse(
        new AlumniMergeNoMatchError('the target is not an active, non-superuser CAS person account')
      );
    }
    const targetSlugs = await this.editor.sourceSlugsOf(target.pk);
    if (targetSlugs.includes(ALUMNI_SOURCE_SLUG)) {
      refuse(new AlumniMergeNoMatchError('the target already holds an Alumni link'));
    }
    if (!targetSlugs.includes(CAS_SOURCE_SLUG)) {
      refuse(new AlumniMergeNoMatchError('the target holds no CAS link'));
    }
    const matches = await this.targetsOf(dup);
    const mode: AlumniMergeMode =
      matches.length === 1 && matches[0].uuid === targetUuid ? 'auto' : 'manual';
    if (mode === 'manual') {
      this.logger.log(
        `[ALUMNI_MERGE] ${tag}: manual - ${matches.length} account(s) match by name and promo, ` +
          'the admin decides identity'
      );
    }
    return { target, mode };
  }

  /**
   * The duplicate half of the allowlist, re-read from MiConnect now: an account created by an Alumni
   * sign-in, a person, whose links are exactly ['alumni'] ({@link AlumniMergeNotDuplicateError}).
   */
  private async assertDuplicateShaped(dup: MiconnectUserListing, tag: string): Promise<void> {
    const refuse = (error: Error): never => {
      this.logger.warn(`[ALUMNI_MERGE] refused ${tag}: ${error.message}`);
      throw error;
    };
    const reason = duplicateShapeRefusal(dup, await this.editor.sourceSlugsOf(dup.pk));
    if (reason) refuse(new AlumniMergeNotDuplicateError(reason));
  }

  /**
   * Whether the Alumni-created account `duplicateUuid` is one an admin can act on NOW
   * ({@link duplicateShapeRefusal}) - the filter of the admins' queue (`UsersController
   * .listAlumniDuplicates`). False for an account MiConnect no longer has.
   */
  async isFlaggable(duplicateUuid: string): Promise<boolean> {
    const account = await this.editor.userByUuid(duplicateUuid);
    if (!account) return false;
    return duplicateShapeRefusal(account, await this.editor.sourceSlugsOf(account.pk)) === null;
  }

  /**
   * Writes the REQUESTED row, under the target's advisory lock: no other open merge may name the
   * target ({@link AlumniMergeTargetBusyError}), and the check and the insert are one transaction, so
   * two duplicates never race into one account. Both subjects are stored now, while both accounts
   * exist. Returns the row's id; another request that opened the same duplicate first stops this one.
   */
  private async openMerge(
    tag: string,
    m: {
      actorId: string;
      dup: MiconnectUserListing;
      target: MiconnectUserListing;
      targetUserId: string | null;
      held: AlumniHoldings;
      mode: AlumniMergeMode;
      reason: string | null;
    }
  ): Promise<string> {
    const inserted = await this.dataSource.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `alumni-merge-target:${m.target.uuid}`,
      ]);
      const busy = (await manager.query(
        `SELECT 1 FROM alumni_merges
          WHERE "targetUuid" = $1 AND "completedAt" IS NULL AND "duplicateUuid" <> $2 LIMIT 1`,
        [m.target.uuid, m.dup.uuid]
      )) as unknown[];
      if (busy.length > 0) {
        this.logger.warn(`[ALUMNI_MERGE] refused ${tag}: another open merge names the target`);
        throw new AlumniMergeTargetBusyError();
      }
      return (await manager.query(
        `INSERT INTO alumni_merges
           ("actorId", "duplicateUuid", "duplicateUsername", "targetUuid", "targetUserId", held,
            mode, reason, "duplicateSubject", "targetSubject")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT ("duplicateUuid") WHERE "completedAt" IS NULL
         DO NOTHING
         RETURNING id`,
        [
          m.actorId,
          m.dup.uuid,
          m.dup.username,
          m.target.uuid,
          m.targetUserId,
          JSON.stringify(m.held),
          m.mode,
          m.reason,
          m.dup.uid || null,
          m.target.uid || null,
        ]
      )) as { id: string }[];
    });
    if (inserted.length !== 1) {
      this.logger.warn(`[ALUMNI_MERGE] refused ${tag}: another request opened it first`);
      throw new AlumniMergeInProgressError();
    }
    this.logger.log(`[ALUMNI_MERGE] requested row written ${tag} mode=${m.mode}`);
    return inserted[0].id;
  }

  /** Whether another open merge (another duplicate) already names this target. */
  private async targetBusy(targetUuid: string, duplicateUuid: string): Promise<boolean> {
    return (await this.openRows()).some(
      (r) => r.targetUuid === targetUuid && r.duplicateUuid !== duplicateUuid
    );
  }

  /**
   * Stores the subjects of an open row that has none yet (D54: a row written before 1.8.3), read
   * from the duplicate in hand and the target - while the duplicate exists, the only time they can be.
   */
  private async captureSubjects(
    row: OpenRow,
    dup: MiconnectUserListing,
    tag: string,
    targetInHand?: MiconnectUserListing
  ): Promise<void> {
    if (row.duplicateSubject && row.targetSubject) return;
    const target =
      targetInHand ??
      (UUID_SHAPE.test(row.targetUuid) ? await this.editor.userByUuid(row.targetUuid) : null);
    const duplicateSubject = dup.uid || null;
    const targetSubject = target?.uid || null;
    await this.dataSource.query(
      `UPDATE alumni_merges
          SET "duplicateSubject" = COALESCE("duplicateSubject", $2),
              "targetSubject" = COALESCE("targetSubject", $3)
        WHERE id = $1 AND "completedAt" IS NULL`,
      [row.id, duplicateSubject, targetSubject]
    );
    row.duplicateSubject ??= duplicateSubject;
    row.targetSubject ??= targetSubject;
    this.logger.log(
      `[ALUMNI_MERGE] subjects captured ${tag}: duplicate=${duplicateSubject ? 'yes' : 'NO'} ` +
        `target=${targetSubject ? 'yes' : 'NO'}`
    );
  }

  /** The open row of a duplicate, or undefined. */
  private async openRow(duplicateUuid: string): Promise<OpenRow | undefined> {
    const [row] = (await this.dataSource.query(
      `SELECT ${OPEN_ROW_COLUMNS}
         FROM alumni_merges
        WHERE "duplicateUuid" = $1 AND "completedAt" IS NULL`,
      [duplicateUuid]
    )) as OpenRow[];
    return row;
  }

  /** Every open row, oldest first. */
  private async openRows(): Promise<OpenRow[]> {
    return (await this.dataSource.query(
      `SELECT ${OPEN_ROW_COLUMNS}
         FROM alumni_merges
        WHERE "completedAt" IS NULL
        ORDER BY "requestedAt"`
    )) as OpenRow[];
  }

  /**
   * Closes a row whose duplicate MiConnect no longer has, `by` the push or the reconciler (D54).
   * `merged` is {@link provenMerged}'s answer, the ONE predicate both callers read: the target holds
   * the duplicate's Alumni link at MiConnect now. Never `markedAt`, which says Canari recorded its
   * mark - a request that died between the mark at MiConnect and that record is merged all the same.
   *
   * A MERGED row is the expected end: the sign-in merged it, and the duplicate's Canari account is
   * erased NOW, after the merge and never before it (owner, 2026-11-24) - requested first, the row
   * closed after, so a call that dies in between finds the row still open and requests again (the
   * erasure is idempotent). A duplicate gone with the target holding no such link went some other way
   * (deleted by hand in MiConnect's admin, or the target itself gone): nothing erased, the row closed,
   * at error when it had been marked.
   *
   * The transaction that closes a MERGED row also writes its sibling-site jobs (D52): a closed merge
   * always owes its sites, and only the closer writes them, with the subjects the row captured at the
   * mark - or, for a row that captured none, the ones MiConnect's push names ({@link PushedSubjects}).
   * The target is read from the closing UPDATE itself, so a target erased meanwhile yields `erase`
   * jobs (the erasure locks the row first, `erasure-policy.ts`).
   * A row closed by the reconciler rather than the push says so at warning, with its age: a dead push
   * is seen the first time an admin opens the page.
   */
  private async complete(
    row: OpenRow,
    tag: string,
    by: Completer,
    merged: boolean,
    pushed: PushedSubjects = {}
  ): Promise<void> {
    if (merged) {
      const duplicateUserId = (await this.canariIdsOf([row.duplicateUuid])).get(row.duplicateUuid);
      if (duplicateUserId) {
        await this.accountErasure.requestErasure(duplicateUserId);
      } else {
        this.logger.log(`[ALUMNI_MERGE] ${tag}: no Canari account to erase`);
      }
    }
    const { closed, jobs } = await this.dataSource.transaction(async (manager) => {
      // The target is read from THIS update, never from `row`: the target's erasure locks the row
      // first (`alumni_merges_lock`), so a close that waited on it reads the blanked target here.
      const [updated] = (await manager.query(
        `UPDATE alumni_merges SET "completedAt" = now(), "completedBy" = $2
          WHERE id = $1 AND "completedAt" IS NULL
          RETURNING id, "duplicateUuid", "targetUuid", "targetSubject"`,
        [row.id, by]
      )) as [
        { id: string; duplicateUuid: string; targetUuid: string; targetSubject: string | null }[],
        number,
      ];
      const closing = (updated ?? [])[0];
      // The admins' queue item goes with the closed row, atomically (see RESOLVE_DUPLICATE_FLAG_SQL).
      if (closing) await manager.query(RESOLVE_DUPLICATE_FLAG_SQL, [closing.duplicateUuid]);
      if (!merged || !closing) return { closed: Boolean(closing), jobs: false };
      const targetErased = closing.targetUuid === DELETED_ACCOUNT;
      const subjects = this.subjectsOf(
        { ...row, targetSubject: closing.targetSubject },
        targetErased ? { duplicateSubject: pushed.duplicateSubject } : pushed,
        tag
      );
      if (!subjects.duplicate || (!targetErased && !subjects.target)) {
        // CANNOT HAPPEN: the mark captures both subjects, a pre-1.8.3 row gets them at its first
        // reading, and the push names both. Reaching here is a broken invariant, never a path.
        this.logger.error(
          `[ALUMNI_MERGE] completed ${tag} merge=${row.id}: no subject on the row nor in the push - ` +
            'an invariant broke (the mark captures both, the push names both); no site job written'
        );
        return { closed: true, jobs: false };
      }
      if (targetErased) {
        // The target's erasure committed after this merge was read: no transfer onto an erased
        // person is owed, the duplicate's accounts on the sites are erased instead (D54).
        this.logger.warn(
          `[ALUMNI_MERGE] completed ${tag} merge=${row.id}: its target was erased meanwhile - ` +
            'the site jobs are erases'
        );
      }
      await this.siteJobs.writeJobs(
        manager,
        row.id,
        subjects.duplicate,
        targetErased ? null : subjects.target
      );
      return { closed: true, jobs: true };
    });
    if (!closed) {
      this.logger.log(`[ALUMNI_MERGE] ${tag}: already closed by another path`);
      return;
    }
    if (merged && by === 'reconciler') {
      const since = row.markedAt ?? row.requestedAt;
      const ageMinutes = Math.round((Date.now() - new Date(since).getTime()) / 60_000);
      this.logger.warn(
        `[ALUMNI_MERGE] completed by the reconciler, not the push ${tag} merge=${row.id} ` +
          `${row.markedAt ? 'marked' : 'requested'} ${ageMinutes} min ago - MiConnect's push did not land`
      );
    } else if (merged) {
      this.logger.log(
        `[ALUMNI_MERGE] completed ${tag} by=${by}: MiConnect merged it at its sign-in`
      );
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
    if (jobs) void this.siteJobs.drain();
  }

  /**
   * The two subjects a merged row's site jobs carry: the row's own, captured while both accounts
   * existed, else the push's. A push naming a subject that differs from the row's is said at error and
   * the row's is kept - it was read from MiConnect, the push is only a hint. Each is null when
   * neither names it.
   */
  private subjectsOf(
    row: OpenRow,
    pushed: PushedSubjects,
    tag: string
  ): { duplicate: string | null; target: string | null } {
    for (const [key, ours, theirs] of [
      ['duplicate', row.duplicateSubject, pushed.duplicateSubject],
      ['target', row.targetSubject, pushed.targetSubject],
    ] as const) {
      if (ours && theirs && ours !== theirs) {
        this.logger.error(
          `[ALUMNI_MERGE] push ${tag}: its ${key} subject differs from the one captured at the mark - ` +
            'the captured one is kept'
        );
      }
    }
    const duplicate = row.duplicateSubject || pushed.duplicateSubject || null;
    const target = row.targetSubject || pushed.targetSubject || null;
    if (duplicate && !row.duplicateSubject) {
      this.logger.log(`[ALUMNI_MERGE] ${tag}: the duplicate's subject taken from the push`);
    }
    return { duplicate, target };
  }

  /**
   * THE ONE PREDICATE OF "MERGED" (D54), read by the push and the reconciler alike: the merge's target
   * holds, at MiConnect now, the duplicate's Alumni link. Never `markedAt`.
   */
  private provenMerged(row: OpenRow): Promise<boolean> {
    return this.targetHoldsTheAlumniLink(row.targetUuid, row.duplicateUsername);
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

  /** A view of MiConnect accounts as the admin page shows them, their Canari ids read once. */
  private async viewer(uuids: string[]): Promise<(u: MiconnectUserListing) => AlumniAccount> {
    const canariIds = await this.canariIdsOf(uuids);
    return (u) => ({
      uuid: u.uuid,
      username: u.username,
      name: u.name,
      email: u.email ?? '',
      lastLogin: u.last_login ?? null,
      promos: promosOf(u.attributes),
      canariUserId: canariIds.get(u.uuid) ?? null,
    });
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
