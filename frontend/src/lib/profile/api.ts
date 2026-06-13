import { apiFetch } from '$lib/utils/apiFetch';
import { socialUrl } from '$lib/utils/apiUrl';
import { coreUrl } from '$lib/utils/apiUrl';

/** Current membership row on a user profile. */
export interface UserMembershipRow {
  associationId: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  role: string;
  isAdmin: boolean;
}

/** Past/honorary association role on a user profile. */
export interface UserRoleHistoryRow {
  id: string;
  userId: string;
  associationId: string;
  associationName: string;
  associationSlug: string;
  associationLogoUrl: string | null;
  roleTitle: string;
  startYear: number | null;
  endYear: number | null;
  sortOrder: number;
  createdAt: string;
}

/** Directory search result row. */
export interface DirectoryUserRow {
  id: string;
  displayName: string | null;
  promo: number | null;
  formation: string | null;
  bio: string | null;
}

export interface DirectorySearchResult {
  users: DirectoryUserRow[];
  total: number;
}

/** Loads public association memberships for a user. */
export async function fetchUserMemberships(userId: string): Promise<UserMembershipRow[]> {
  const res = await apiFetch(
    `${socialUrl()}/api/associations/users/${encodeURIComponent(userId)}/memberships`
  );
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()) as UserMembershipRow[];
}

/** Loads role history for a user profile. */
export async function fetchUserRoleHistory(userId: string): Promise<UserRoleHistoryRow[]> {
  const res = await apiFetch(
    `${socialUrl()}/api/associations/users/${encodeURIComponent(userId)}/role-history`
  );
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()) as UserRoleHistoryRow[];
}

/** Adds a role history entry to the caller's profile. */
export async function createMyRoleHistory(payload: {
  associationId: string;
  roleTitle: string;
  startYear?: number;
  endYear?: number;
}): Promise<UserRoleHistoryRow> {
  const res = await apiFetch(`${socialUrl()}/api/associations/users/me/role-history`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message || `Erreur (${res.status})`);
  }
  return (await res.json()) as UserRoleHistoryRow;
}

/** Updates a role history entry on the caller's profile. */
export async function updateMyRoleHistory(
  entryId: string,
  payload: Partial<{
    associationId: string;
    roleTitle: string;
    startYear: number | null;
    endYear: number | null;
  }>
): Promise<UserRoleHistoryRow> {
  const res = await apiFetch(
    `${socialUrl()}/api/associations/users/me/role-history/${encodeURIComponent(entryId)}`,
    { method: 'PATCH', body: JSON.stringify(payload) }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message || `Erreur (${res.status})`);
  }
  return (await res.json()) as UserRoleHistoryRow;
}

/** Deletes a role history entry from the caller's profile. */
export async function deleteMyRoleHistory(entryId: string): Promise<void> {
  const res = await apiFetch(
    `${socialUrl()}/api/associations/users/me/role-history/${encodeURIComponent(entryId)}`,
    { method: 'DELETE' }
  );
  if (!res.ok) throw new Error(`Erreur (${res.status})`);
}

/** Formats a role history period for display. */
export function formatRoleHistoryPeriod(startYear: number | null, endYear: number | null): string {
  if (startYear != null && endYear != null) return `${startYear} – ${endYear}`;
  if (startYear != null) return `Depuis ${startYear}`;
  if (endYear != null) return `Jusqu'en ${endYear}`;
  return '';
}

/** Searches the user directory with optional filters. */
export async function searchDirectory(params: {
  q?: string;
  promo?: number;
  formation?: string;
  associationId?: string;
  limit?: number;
  offset?: number;
}): Promise<DirectorySearchResult> {
  const p = new URLSearchParams();
  if (params.q?.trim()) p.set('q', params.q.trim());
  if (params.promo != null && !Number.isNaN(params.promo)) p.set('promo', String(params.promo));
  if (params.formation?.trim()) p.set('formation', params.formation.trim());
  if (params.associationId?.trim()) p.set('associationId', params.associationId.trim());
  if (params.limit != null) p.set('limit', String(params.limit));
  if (params.offset != null) p.set('offset', String(params.offset));

  const res = await apiFetch(`${coreUrl()}/api/users/directory?${p.toString()}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message || `Erreur (${res.status})`);
  }
  return (await res.json()) as DirectorySearchResult;
}
