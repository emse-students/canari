/**
 * The Alumni duplicates and their merge (D47, D48), as `core-service` serves them to a global admin.
 * Refusals are typed by the `code` in the body: the profile editor's codes (the merge goes through
 * the same MiConnect account) plus the merge's own, and the client branches on them, never on prose.
 */
import { apiFetch } from '$lib/utils/apiFetch';
import { coreUrl } from '$lib/utils/apiUrl';
import { Log } from '$lib/utils/Log';
import { m } from '$lib/paraglide/messages';
import { profileErrorMessage, readProfileError } from './profileEdit';

/** One MiConnect account of the duplicates list. */
export interface AlumniAccount {
  uuid: string;
  username: string;
  name: string;
  /** With `lastLogin`, what tells two homonyms apart. */
  email: string;
  /** ISO time of the last MiConnect sign-in, null when it never signed in. */
  lastLogin: string | null;
  promos: number[];
  canariUserId: string | null;
}

/**
 * `auto`: the target is the duplicate's unique match by name and promo (D47). `manual`: an admin
 * chose it with a written reason (D55), and MiConnect re-checks both names at the sign-in.
 */
type AlumniMergeMode = 'auto' | 'manual';

/**
 * The bounds of a manual merge's reason, in code points after trimming: the server's
 * (`alumni-merge.errors.ts`), both asserted against `libs/contracts/alumni-merge-reason.json`.
 */
export const ALUMNI_MERGE_REASON_MIN = 20;
export const ALUMNI_MERGE_REASON_MAX = 1000;

/**
 * An open merge: `marked` waits for the duplicate's next Alumni sign-in, when MiConnect merges it;
 * `requested` is an interrupted "Rattacher", resumed by the same action. Either can be cancelled.
 */
export interface AlumniOpenMerge {
  duplicateUuid: string;
  duplicateUsername: string;
  targetUuid: string;
  status: 'requested' | 'marked';
  mode: AlumniMergeMode;
  /** The admin's written reason, a manual merge only. */
  reason: string | null;
  requestedAt: string;
  markedAt: string | null;
}

/**
 * One sibling site's job of a completed merge (D52-D54). `unready`: the site does not serve its half
 * yet, asked again daily.
 */
interface AlumniMergeSiteState {
  site: string;
  state: 'pending' | 'unready' | 'blocked' | 'done';
  outcome: 'absent' | 'transferred' | 'merged' | null;
  attempts: number;
  lastError: string | null;
}

/** A completed merge, with what each sibling site did of it. */
export interface AlumniClosedMerge {
  id: string;
  duplicateUsername: string;
  targetUuid: string;
  mode: AlumniMergeMode;
  reason: string | null;
  completedAt: string;
  /** `reconciler` means the push never arrived: the page reading completed it. */
  completedBy: 'push' | 'reconciler' | null;
  sites: AlumniMergeSiteState[];
}

/** The sentence for one sibling site's job of a completed merge, as the admin page lists it. */
export function alumniSiteLine(s: AlumniMergeSiteState): string {
  if (s.state === 'done') {
    const outcome =
      s.outcome === 'transferred'
        ? m.admin_alumni_site_outcome_transferred()
        : s.outcome === 'merged'
          ? m.admin_alumni_site_outcome_merged()
          : m.admin_alumni_site_outcome_absent();
    return m.admin_alumni_site_done({ site: s.site, outcome });
  }
  if (s.state === 'blocked') {
    return m.admin_alumni_site_blocked({ site: s.site, error: s.lastError ?? '' });
  }
  // Not a failure: the site has not shipped its half, and is asked again daily.
  if (s.state === 'unready') return m.admin_alumni_site_unready({ site: s.site });
  return m.admin_alumni_site_pending({ site: s.site, attempts: s.attempts });
}

/**
 * An Alumni-created account and the accounts it matches by name and promo. `targets` is empty for
 * one that matches nobody: only a manual merge (D55) can attach it.
 */
export interface AlumniDuplicate {
  duplicate: AlumniAccount;
  targets: AlumniAccount[];
}

/** What the duplicate holds in Canari, shown before the admin confirms. */
export interface AlumniHoldings {
  canariAccount: boolean;
  personalPosts: number;
  associations: number;
  communities: number;
  formSubmissions: number;
  conversations: number;
}

/** The merge's own refusal codes (`alumni-merge.errors.ts`). */
const ALUMNI_MERGE_CODES = [
  'ALUMNI_MERGE_NOT_FOUND',
  'ALUMNI_MERGE_NOT_DUPLICATE',
  'ALUMNI_MERGE_NO_MATCH',
  'ALUMNI_MERGE_HOLDINGS_UNAVAILABLE',
  'ALUMNI_MERGE_IN_PROGRESS',
  'ALUMNI_MERGE_ALREADY_MERGED',
  'ALUMNI_MERGE_REASON_REQUIRED',
  'ALUMNI_MERGE_TARGET_BUSY',
  'ALUMNI_MERGE_NOT_MERGED',
] as const;
type AlumniMergeCode = (typeof ALUMNI_MERGE_CODES)[number];

/** A refused merge call carrying the merge's own code. */
class AlumniMergeError extends Error {
  constructor(
    readonly status: number,
    readonly code: AlumniMergeCode
  ) {
    super(`alumni merge refused (${status} ${code})`);
    this.name = 'AlumniMergeError';
  }
}

/** Reads a failed answer: the merge's own code, else the profile editor's typed refusal. */
async function refusal(res: Response): Promise<Error> {
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { code?: unknown } | null;
  const own = ALUMNI_MERGE_CODES.find((c) => c === body?.code);
  return own ? new AlumniMergeError(res.status, own) : readProfileError(res);
}

/** The sentence an admin reads for a refused call. */
export function alumniMergeErrorMessage(err: unknown): string {
  if (!(err instanceof AlumniMergeError)) return profileErrorMessage(err);
  switch (err.code) {
    case 'ALUMNI_MERGE_NOT_FOUND':
      return m.alumni_merge_error_not_found();
    case 'ALUMNI_MERGE_NOT_DUPLICATE':
      return m.alumni_merge_error_not_duplicate();
    case 'ALUMNI_MERGE_NO_MATCH':
      return m.alumni_merge_error_no_match();
    case 'ALUMNI_MERGE_HOLDINGS_UNAVAILABLE':
      return m.alumni_merge_error_holdings();
    case 'ALUMNI_MERGE_IN_PROGRESS':
      return m.alumni_merge_error_in_progress();
    case 'ALUMNI_MERGE_ALREADY_MERGED':
      return m.alumni_merge_error_already_merged();
    case 'ALUMNI_MERGE_REASON_REQUIRED':
      return m.alumni_merge_error_reason_required({
        min: ALUMNI_MERGE_REASON_MIN,
        max: ALUMNI_MERGE_REASON_MAX,
      });
    case 'ALUMNI_MERGE_TARGET_BUSY':
      return m.alumni_merge_error_target_busy();
    case 'ALUMNI_MERGE_NOT_MERGED':
      return m.alumni_merge_error_not_merged();
  }
}

const base = () => `${coreUrl()}/api/users/admin/alumni-duplicates`;
const mergesUrl = () => `${coreUrl()}/api/users/admin/alumni-merges`;

/** The flagged duplicates. */
export async function fetchAlumniDuplicates(): Promise<AlumniDuplicate[]> {
  const res = await apiFetch(base());
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as AlumniDuplicate[];
}

/** What one duplicate holds in Canari. */
export async function fetchAlumniHoldings(duplicateUuid: string): Promise<AlumniHoldings> {
  const res = await apiFetch(`${base()}/${encodeURIComponent(duplicateUuid)}/holdings`);
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as AlumniHoldings;
}

/** The open merges, reconciled with MiConnect by the server. */
export async function fetchAlumniOpenMerges(): Promise<AlumniOpenMerge[]> {
  const res = await apiFetch(mergesUrl());
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as AlumniOpenMerge[];
}

/** The completed merges, each with its sibling sites' states. */
export async function fetchAlumniClosedMerges(): Promise<AlumniClosedMerge[]> {
  const res = await apiFetch(`${mergesUrl()}/closed`);
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as AlumniClosedMerge[];
}

/**
 * The accounts a manual merge may attach the duplicate to, searched by name (D55): CAS-linked, no
 * Alumni link, no other open merge. The server answers nothing under two characters.
 */
export async function fetchAlumniMergeTargets(
  duplicateUuid: string,
  query: string
): Promise<AlumniAccount[]> {
  const res = await apiFetch(
    `${base()}/${encodeURIComponent(duplicateUuid)}/targets?q=${encodeURIComponent(query)}`
  );
  if (!res.ok) throw await refusal(res);
  return (await res.json()) as AlumniAccount[];
}

/** Where a manual merge's reason stands against the server's bounds, in code points of the trimmed text. */
export interface AlumniReasonState {
  length: number;
  valid: boolean;
  /** Why it is not valid yet, null when it is. */
  problem: 'too_short' | 'too_long' | null;
}

/** The same rule the server applies (`checkMergeReason`), so the button is enabled only when it would pass. */
export function alumniReasonState(text: string): AlumniReasonState {
  // Code points, as the server counts: `.length` would count an emoji twice.
  const length = [...text.trim()].length;
  const problem =
    length < ALUMNI_MERGE_REASON_MIN
      ? 'too_short'
      : length > ALUMNI_MERGE_REASON_MAX
        ? 'too_long'
        : null;
  return { length, valid: problem === null, problem };
}

/** "Annuler": removes the mark at MiConnect and closes the merge. */
export async function cancelAlumniMerge(duplicateUuid: string): Promise<void> {
  Log.d('alumniMerge.cancel', { dup: duplicateUuid.slice(0, 8) });
  const res = await apiFetch(`${base()}/${encodeURIComponent(duplicateUuid)}/cancel`, {
    method: 'POST',
  });
  if (!res.ok) throw await refusal(res);
}

/**
 * "Rattacher" (D48): marks the duplicate for MiConnect, which merges it at its next Alumni sign-in,
 * and erases its Canari account. Called again, it resumes an interrupted one. A target that is not
 * the unique match needs `reason` (D55): the server decides the mode, never the client.
 */
export async function mergeAlumniDuplicate(
  duplicateUuid: string,
  targetUuid: string,
  reason?: string
): Promise<void> {
  Log.d('alumniMerge.merge', {
    dup: duplicateUuid.slice(0, 8),
    target: targetUuid.slice(0, 8),
    withReason: reason !== undefined,
  });
  const res = await apiFetch(`${base()}/${encodeURIComponent(duplicateUuid)}/merge`, {
    method: 'POST',
    body: JSON.stringify(reason === undefined ? { targetUuid } : { targetUuid, reason }),
  });
  if (!res.ok) throw await refusal(res);
}
