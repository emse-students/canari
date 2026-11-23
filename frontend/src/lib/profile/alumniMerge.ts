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
  promos: number[];
  canariUserId: string | null;
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
export const ALUMNI_MERGE_CODES = [
  'ALUMNI_MERGE_NOT_FOUND',
  'ALUMNI_MERGE_NOT_DUPLICATE',
  'ALUMNI_MERGE_NO_MATCH',
  'ALUMNI_MERGE_HOLDINGS_UNAVAILABLE',
] as const;
export type AlumniMergeCode = (typeof ALUMNI_MERGE_CODES)[number];

/** A refused merge call carrying the merge's own code. */
export class AlumniMergeError extends Error {
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
  }
}

const base = () => `${coreUrl()}/api/users/admin/alumni-duplicates`;

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

/** "Rattacher": deletes the duplicate and erases its Canari account (D48). */
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
