import { apiFetch } from '$lib/utils/apiFetch';
import { getToken } from '$lib/stores/auth';
import { coreUrl, socialUrl } from '$lib/utils/apiUrl';

/**
 * Discord-style permission flags for association members (mirrors the backend enum).
 * Combine flags with bitwise OR; test with `(permissions & flag) !== 0`.
 */
export enum AssociationPermissionFlag {
  POST_AS_ASSO = 1 << 0,
  PROPOSE_EVENT = 1 << 1,
  MANAGE_MEMBERS = 1 << 2,
  MANAGE_DOCUMENTS = 1 << 3,
  MANAGE_FORMS = 1 << 4,
  VALIDATE_EVENTS = 1 << 5,
  CREATE_ASSO = 1 << 6,
  MODERATE = 1 << 7,
  MANAGE_PRODUCTS = 1 << 8,
}

/** Returns true if `permissions` includes `flag`. */
export function hasPermissionFlag(permissions: number, flag: AssociationPermissionFlag): boolean {
  return (permissions & flag) !== 0;
}

export interface AssociationMember {
  id: string;
  associationId: string;
  userId: string;
  displayName: string | null;
  role: string;
  /** True if the member has at least one permission flag set. */
  isAdmin: boolean;
  /** Full bitmask — only present when the caller holds MANAGE_MEMBERS. */
  permissions?: number;
  createdAt: string;
}

export interface Association {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  bioMarkdown: string | null;
  logoUrl: string | null;
  stripeAccountId: string | null;
  stripeOnboardingComplete: boolean;
  /** True if this is the BDE association (unlocks BDE-only permission flags). */
  isBDE: boolean;
  /** Hex-encoded 32-byte master key for the document vault (MANAGE_DOCUMENTS only). */
  documentVaultKey?: string | null;
  /** Maximum vault storage in bytes (default 500 MiB). */
  documentQuotaBytes: number;
  createdBy: string;
  memberCount?: number;
  role?: string;
  /** Bitmask of AssociationPermissionFlag (from `/api/associations/me/list`). */
  permissions?: number;
  /** True if the calling user has at least one permission in this association. */
  isAdmin?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAssociationPayload {
  name: string;
  slug: string;
  description?: string;
  bioMarkdown?: string;
  logoUrl?: string;
}

export interface UpdateAssociationPayload {
  name?: string;
  description?: string;
  bioMarkdown?: string;
  logoUrl?: string;
  /** Global admin only — marks this association as the BDE. */
  isBDE?: boolean;
  /** Global admin only — sets the document vault quota in bytes. */
  documentQuotaBytes?: number;
}

export type AssociationCalendarEventStatus = 'pending' | 'validated';

export interface AssociationCalendarEvent {
  id: string;
  associationId: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  createdBy: string;
  createdAt: string;
  status: AssociationCalendarEventStatus;
  validatedAt: string | null;
  validatedBy: string | null;
  /** Same-association form (optional). */
  linkedFormId: string | null;
}

/** Row from `GET /api/associations/calendar/feed` (aggregated agenda). */
export interface AssociationCalendarFeedEvent extends AssociationCalendarEvent {
  associationName: string;
  associationSlug: string;
}

export interface AssociationLinkCandidates {
  forms: { id: string; title: string; updatedAt: string }[];
}

export interface CreateAssociationCalendarEventPayload {
  title: string;
  description?: string;
  startsAt: string;
  endsAt?: string;
  linkedFormId?: string;
}

export interface UpdateAssociationCalendarEventPayload {
  title?: string;
  description?: string;
  startsAt?: string;
  endsAt?: string;
  linkedFormId?: string | null;
}

/** Validated agenda events for linking from a publication (wide date window). */
export async function listLinkableValidatedCalendarEvents(
  associationId: string
): Promise<AssociationCalendarEvent[]> {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 12, 1).toISOString();
  const to = new Date(now.getFullYear(), now.getMonth() + 24, 0, 23, 59, 59, 999).toISOString();
  return listAssociationCalendarEvents(associationId, { from, to });
}

/** Resolve association logo URL for `<img src>` (handles relative `/api/...` paths).
 *  On Tauri/mobile, window.location.origin is `tauri://localhost` — use VITE_MEDIA_URL instead. */
export function associationLogoSrc(logoUrl: string | null | undefined): string | null {
  if (!logoUrl?.trim()) return null;
  const u = logoUrl.trim();
  if (u.startsWith('/')) {
    const mediaBase =
      (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_MEDIA_URL?.trim()) ||
      (typeof window !== 'undefined' ? window.location.origin : '');
    return `${mediaBase}${u}`;
  }
  return u;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = socialUrl();
  const res = await apiFetch(`${base}${path}`, init as any);
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`associations ${res.status}: ${details || res.statusText}`);
  }
  return (await res.json()) as T;
}

// ── Public ────────────────────────────────────────────────────────────────

export async function listAssociations(): Promise<Association[]> {
  return request<Association[]>('/api/associations');
}

export async function getAssociation(id: string): Promise<Association> {
  return request<Association>(`/api/associations/${encodeURIComponent(id)}`);
}

export async function getAssociationBySlug(slug: string): Promise<Association> {
  return request<Association>(`/api/associations/slug/${encodeURIComponent(slug)}`);
}

export async function listMembers(associationId: string): Promise<AssociationMember[]> {
  return request<AssociationMember[]>(
    `/api/associations/${encodeURIComponent(associationId)}/members`
  );
}

export async function listAssociationCalendarEvents(
  associationId: string,
  opts?: { from?: string; to?: string; includePending?: boolean }
): Promise<AssociationCalendarEvent[]> {
  const q = new URLSearchParams();
  if (opts?.from) q.set('from', opts.from);
  if (opts?.to) q.set('to', opts.to);
  if (opts?.includePending) q.set('includePending', 'true');
  const qs = q.toString();
  return request<AssociationCalendarEvent[]>(
    `/api/associations/${encodeURIComponent(associationId)}/events${qs ? `?${qs}` : ''}`
  );
}

/** Aggregated public agenda for a date range (optional `associationId` filter). */
export async function listAggregatedCalendarFeed(opts: {
  from: string;
  to: string;
  associationId?: string;
}): Promise<AssociationCalendarFeedEvent[]> {
  const q = new URLSearchParams();
  q.set('from', opts.from);
  q.set('to', opts.to);
  if (opts.associationId?.trim()) q.set('associationId', opts.associationId.trim());
  return request<AssociationCalendarFeedEvent[]>(`/api/associations/calendar/feed?${q.toString()}`);
}

/** Path + query for the dynamic iCalendar feed (same params as `listAggregatedCalendarFeed`). */
export function aggregatedCalendarFeedIcsPath(opts: {
  from: string;
  to: string;
  associationId?: string;
}): string {
  const q = new URLSearchParams();
  q.set('from', opts.from);
  q.set('to', opts.to);
  if (opts.associationId?.trim()) q.set('associationId', opts.associationId.trim());
  return `/api/associations/calendar/feed.ics?${q.toString()}`;
}

/**
 * Absolute URL to `feed.ics` for the given window. Prefer `socialUrl()` when set (Tauri / split API).
 */
export function aggregatedCalendarFeedIcsAbsoluteUrl(opts: {
  from: string;
  to: string;
  associationId?: string;
}): string {
  const path = aggregatedCalendarFeedIcsPath(opts);
  const base = socialUrl();
  if (base) return `${base}${path}`;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${path}`;
  }
  return path;
}

export async function createAssociationCalendarEvent(
  associationId: string,
  payload: CreateAssociationCalendarEventPayload
): Promise<AssociationCalendarEvent> {
  return request<AssociationCalendarEvent>(
    `/api/associations/${encodeURIComponent(associationId)}/events`,
    { method: 'POST', body: JSON.stringify(payload) }
  );
}

export async function updateAssociationCalendarEvent(
  associationId: string,
  eventId: string,
  payload: UpdateAssociationCalendarEventPayload
): Promise<AssociationCalendarEvent> {
  return request<AssociationCalendarEvent>(
    `/api/associations/${encodeURIComponent(associationId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'PATCH', body: JSON.stringify(payload) }
  );
}

export async function deleteAssociationCalendarEvent(
  associationId: string,
  eventId: string
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/api/associations/${encodeURIComponent(associationId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE' }
  );
}

export async function validateAssociationCalendarEvent(
  associationId: string,
  eventId: string
): Promise<AssociationCalendarEvent> {
  return request<AssociationCalendarEvent>(
    `/api/associations/${encodeURIComponent(associationId)}/events/${encodeURIComponent(eventId)}/validate`,
    { method: 'POST' }
  );
}

/** Pending events the caller may validate (global admin: all associations). */
export async function listPendingCalendarEvents(): Promise<AssociationCalendarFeedEvent[]> {
  return request<AssociationCalendarFeedEvent[]>('/api/associations/calendar/pending');
}

/** Association admins — publications et formulaires récents pour lier un événement d’agenda. */
export async function listAssociationLinkCandidates(
  associationId: string
): Promise<AssociationLinkCandidates> {
  return request<AssociationLinkCandidates>(
    `/api/associations/${encodeURIComponent(associationId)}/link-candidates`
  );
}

/** Public — événement d’agenda pointant vers cette publication (fil). */
export async function getCalendarEventLinkedToPost(postId: string): Promise<{
  linkedEvent: AssociationCalendarEvent | null;
}> {
  const base = socialUrl();
  const res = await apiFetch(`${base}/api/posts/${encodeURIComponent(postId)}/calendar-link`);
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`posts ${res.status}: ${details || res.statusText}`);
  }
  return (await res.json()) as { linkedEvent: AssociationCalendarEvent | null };
}

/** Public — événement d’agenda pointant vers ce formulaire. */
export async function getCalendarEventLinkedToForm(formId: string): Promise<{
  linkedEvent: AssociationCalendarEvent | null;
}> {
  const base = socialUrl();
  const res = await apiFetch(`${base}/api/forms/${encodeURIComponent(formId)}/calendar-link`);
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`forms ${res.status}: ${details || res.statusText}`);
  }
  return (await res.json()) as { linkedEvent: AssociationCalendarEvent | null };
}

// ── Authenticated ─────────────────────────────────────────────────────────

export async function listMyAssociations(): Promise<Association[]> {
  return request<Association[]>('/api/associations/me/list');
}

export async function listMyFollowedAssociations(): Promise<
  Pick<Association, 'id' | 'name' | 'slug' | 'logoUrl'>[]
> {
  return request<Pick<Association, 'id' | 'name' | 'slug' | 'logoUrl'>[]>(
    '/api/associations/me/following'
  );
}

export async function getAssociationFollowStatus(
  associationId: string
): Promise<{ following: boolean }> {
  return request<{ following: boolean }>(
    `/api/associations/${encodeURIComponent(associationId)}/follow-status`
  );
}

export async function followAssociation(associationId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/associations/${encodeURIComponent(associationId)}/follow`, {
    method: 'POST',
  });
}

export async function unfollowAssociation(associationId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/associations/${encodeURIComponent(associationId)}/follow`, {
    method: 'DELETE',
  });
}

export async function createAssociation(payload: CreateAssociationPayload): Promise<Association> {
  return request<Association>('/api/associations', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// ── Admin / Owner ─────────────────────────────────────────────────────────

export async function updateAssociation(
  id: string,
  payload: UpdateAssociationPayload
): Promise<Association> {
  return request<Association>(`/api/associations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function deleteAssociation(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/associations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function uploadAssociationLogo(
  associationId: string,
  file: File
): Promise<Association> {
  const base = socialUrl();
  const token = await getToken().catch(() => '');
  const fd = new FormData();
  fd.append('file', file);
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${base}/api/associations/${encodeURIComponent(associationId)}/logo`, {
    method: 'POST',
    headers,
    body: fd,
  });
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`associations ${res.status}: ${details || res.statusText}`);
  }
  return (await res.json()) as Association;
}

export async function deleteAssociationLogo(associationId: string): Promise<Association> {
  return request<Association>(`/api/associations/${encodeURIComponent(associationId)}/logo`, {
    method: 'DELETE',
  });
}

/**
 * Adds a member to an association with the given role and permissions bitmask.
 * @param permissions - Bitmask of `AssociationPermissionFlag` values (0 = simple member).
 */
export async function addMember(
  associationId: string,
  userId: string,
  role: string,
  permissions: number
): Promise<AssociationMember> {
  return request<AssociationMember>(
    `/api/associations/${encodeURIComponent(associationId)}/members`,
    { method: 'POST', body: JSON.stringify({ userId, role, permissions }) }
  );
}

/**
 * Updates a member's role label and/or permissions bitmask.
 * @param permissions - Full new bitmask (replaces the old one entirely).
 */
export async function updateMemberRole(
  associationId: string,
  userId: string,
  role?: string,
  permissions?: number
): Promise<AssociationMember> {
  return request<AssociationMember>(
    `/api/associations/${encodeURIComponent(associationId)}/members/${encodeURIComponent(userId)}`,
    { method: 'PATCH', body: JSON.stringify({ role, permissions }) }
  );
}

export async function removeMember(
  associationId: string,
  userId: string
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/api/associations/${encodeURIComponent(associationId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' }
  );
}

// ── Stripe onboarding ───────────────────────────────────────────────────────

export async function startStripeOnboarding(
  associationId: string,
  existingAccountId?: string,
  opts?: { returnUrl?: string; refreshUrl?: string }
): Promise<{ url: string; accountId: string }> {
  const base = coreUrl();
  const res = await apiFetch(`${base}/api/payments/onboarding`, {
    method: 'POST',
    body: JSON.stringify({
      associationId,
      existingAccountId,
      returnUrl: opts?.returnUrl,
      refreshUrl: opts?.refreshUrl,
    }),
  });
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`onboarding ${res.status}: ${details || res.statusText}`);
  }
  return (await res.json()) as { url: string; accountId: string };
}
