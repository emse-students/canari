import { apiFetch } from '$lib/utils/apiFetch';
import { coreUrl } from '$lib/utils/apiUrl';
import { Log } from '$lib/utils/Log';
import { m } from '$lib/paraglide/messages';
import type { Campus, CursusEntry, Post } from './miconnectProfile';

/** The formations a cursus may name (D4): ONE list, `miconnectProfile`'s, which mirrors `core-service` `FORMATIONS`. */
export { FORMATIONS, type Formation } from './miconnectProfile';

/** The longest message a person may write to the admins. Mirrors `CORRECTION_MESSAGE_MAX`. */
export const CORRECTION_MESSAGE_MAX = 1000;
/** The longest note an admin may attach to a refusal. Mirrors `CORRECTION_NOTE_MAX`. */
export const CORRECTION_NOTE_MAX = 500;

/** The whole profile an admin sets: what `PUT /users/:id/profile` takes. */
export interface ProfileEditInput {
  campus: Campus;
  cursus: CursusEntry[];
  posts: Post[];
  firstName: string;
  lastName: string;
}

/** A correction request, as `core-service` serves it. */
export interface CorrectionRequest {
  id: string;
  userId: string;
  message: string;
  status: 'pending' | 'applied' | 'refused';
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

/** A queue row: the request plus the name the admin recognises the person by. */
export interface CorrectionQueueRow extends CorrectionRequest {
  displayName: string | null;
}

/**
 * The refusal codes the profile endpoints answer with, as a closed set. The server classifies at the
 * throw and sends the code in the body; the client branches on it and NEVER on the message.
 */
export const PROFILE_ERROR_CODES = [
  'PROFILE_EDIT_INVALID',
  'PROFILE_EDIT_DEV_ESTATE',
  'PROFILE_EDIT_NOT_CONFIGURED',
  'PROFILE_EDIT_NOT_LINKED',
  'PROFILE_EDIT_UPSTREAM',
  'PROFILE_CORRECTION_INVALID',
  'PROFILE_CORRECTION_PENDING',
  'PROFILE_CORRECTION_NOT_FOUND',
  'PROFILE_CORRECTION_NOT_PENDING',
] as const;
export type ProfileErrorCode = (typeof PROFILE_ERROR_CODES)[number];

/** A refused profile call: the HTTP status, and the typed code when the server sent one. */
export class ProfileApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ProfileErrorCode | null,
    readonly problems: { field: string }[] = []
  ) {
    super(`profile call refused (${status}${code ? ` ${code}` : ''})`);
    this.name = 'ProfileApiError';
  }
}

/** Reads a failed response into a {@link ProfileApiError}; an unknown or absent code is `null`. */
export async function readProfileError(res: Response): Promise<ProfileApiError> {
  const body = (await res.json().catch(() => null)) as {
    code?: unknown;
    problems?: { field: string }[];
  } | null;
  const code = PROFILE_ERROR_CODES.find((c) => c === body?.code) ?? null;
  return new ProfileApiError(res.status, code, Array.isArray(body?.problems) ? body.problems : []);
}

/** The localized sentence for a failed profile call. */
export function profileErrorMessage(err: unknown): string {
  const code = err instanceof ProfileApiError ? err.code : null;
  switch (code) {
    case 'PROFILE_EDIT_INVALID':
      return m.profile_edit_error_invalid();
    case 'PROFILE_EDIT_DEV_ESTATE':
      return m.profile_edit_error_dev_estate();
    case 'PROFILE_EDIT_NOT_CONFIGURED':
      return m.profile_edit_error_not_configured();
    case 'PROFILE_EDIT_NOT_LINKED':
      return m.profile_edit_error_not_linked();
    case 'PROFILE_EDIT_UPSTREAM':
      return m.profile_edit_error_upstream();
    case 'PROFILE_CORRECTION_INVALID':
      return m.profile_correction_error_invalid();
    case 'PROFILE_CORRECTION_PENDING':
      return m.profile_correction_error_pending();
    case 'PROFILE_CORRECTION_NOT_FOUND':
    case 'PROFILE_CORRECTION_NOT_PENDING':
      return m.profile_correction_error_answered();
    default:
      return m.common_generic_error_label();
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await readProfileError(res);
  return (await res.json()) as T;
}

/**
 * Saves a person's whole profile (global admin). `requestId` makes the edit the ANSWER to that
 * correction request: the server closes it and notifies the person.
 */
export async function saveProfile(
  userId: string,
  input: ProfileEditInput,
  requestId?: string
): Promise<{ changed: boolean }> {
  Log.d('profile.save', { user: userId.slice(0, 8), forRequest: !!requestId });
  const res = await apiFetch(`${coreUrl()}/api/users/${encodeURIComponent(userId)}/profile`, {
    method: 'PUT',
    body: JSON.stringify(requestId ? { ...input, requestId } : input),
  });
  return json(res);
}

/** The caller's open correction request, else their latest answered one, else `null`. */
export async function fetchMyCorrection(): Promise<CorrectionRequest | null> {
  const res = await apiFetch(`${coreUrl()}/api/users/me/profile-correction`);
  return (await json<{ request: CorrectionRequest | null }>(res)).request;
}

/** Asks the admins to correct the caller's profile. */
export async function requestCorrection(message: string): Promise<CorrectionRequest> {
  const res = await apiFetch(`${coreUrl()}/api/users/me/profile-correction`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
  return (await json<{ request: CorrectionRequest }>(res)).request;
}

/** The admin queue of open correction requests, oldest first. */
export async function fetchCorrectionQueue(): Promise<CorrectionQueueRow[]> {
  const res = await apiFetch(`${coreUrl()}/api/users/admin/profile-corrections`);
  return json<CorrectionQueueRow[]>(res);
}

/** Refuses a correction request, with an optional note the person is shown. */
export async function refuseCorrection(requestId: string, note: string): Promise<void> {
  const res = await apiFetch(
    `${coreUrl()}/api/users/admin/profile-corrections/${encodeURIComponent(requestId)}/refuse`,
    { method: 'POST', body: JSON.stringify({ note }) }
  );
  await json(res);
}
