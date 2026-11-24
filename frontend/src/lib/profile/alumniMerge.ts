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
 * An open merge: `marked` waits for the duplicate's next Alumni sign-in, when MiConnect merges it;
 * `requested` is an interrupted "Rattacher", resumed by the same action. Either can be cancelled.
 */
export interface AlumniOpenMerge {
  duplicateUuid: string;
  duplicateUsername: string;
  targetUuid: string;
  status: 'requested' | 'marked';
  requestedAt: string;
  markedAt: string | null;
}

/** A flagged duplicate and the accounts it matches by name and promo. */
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
 * and erases its Canari account. Called again, it resumes an interrupted one.
 */
export async function mergeAlumniDuplicate(
  duplicateUuid: string,
  targetUuid: string
): Promise<void> {
  Log.d('alumniMerge.merge', { dup: duplicateUuid.slice(0, 8), target: targetUuid.slice(0, 8) });
  const res = await apiFetch(`${base()}/${encodeURIComponent(duplicateUuid)}/merge`, {
    method: 'POST',
    body: JSON.stringify({ targetUuid }),
  });
  if (!res.ok) throw await refusal(res);
}
