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
  MANAGE_STRIPE_CONNECT = 1 << 9,
}

/**
 * Non-BDE flags granted to association admins (excludes Stripe Connect).
 * Mirrors backend `ALL_CORE_FLAGS`.
 */
export const ALL_CORE_FLAGS =
  AssociationPermissionFlag.POST_AS_ASSO |
  AssociationPermissionFlag.PROPOSE_EVENT |
  AssociationPermissionFlag.MANAGE_MEMBERS |
  AssociationPermissionFlag.MANAGE_DOCUMENTS |
  AssociationPermissionFlag.MANAGE_FORMS |
  AssociationPermissionFlag.MANAGE_PRODUCTS;

/** Default admin preset when adding a member (core flags + Stripe Connect). */
export const ASSOCIATION_ADMIN_PRESET =
  ALL_CORE_FLAGS | AssociationPermissionFlag.MANAGE_STRIPE_CONNECT;

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
  /** Full bitmask - only present when the caller holds MANAGE_MEMBERS. */
  permissions?: number;
  /** Display position - lower values appear first. */
  sortOrder?: number;
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
  /** Hex color for calendar display (e.g. "#e83e8c"). Null → frontend uses generateAvatarColor fallback. */
  color?: string | null;
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
  description?: string | null;
  bioMarkdown?: string | null;
  logoUrl?: string;
  /** Global admin only - marks this association as the BDE. */
  isBDE?: boolean;
  /** Global admin only - sets the document vault quota in bytes. */
  documentQuotaBytes?: number;
  /** Hex color for calendar display. Pass `""` or `null` to revert to auto-generated color. */
  color?: string | null;
}

export type AssociationCalendarEventStatus = 'pending' | 'validated' | 'rejected';

/** Lean summary of an association co-owning a calendar event. */
export interface CalendarEventCoOwner {
  associationId: string;
  name: string;
  slug: string;
  /** Hex color (e.g. "#e83e8c") or null → frontend falls back to generateAvatarColor. */
  color: string | null;
  logoUrl: string | null;
}

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
  rejectedAt: string | null;
  rejectedBy: string | null;
  /** Optional message from the BDE explaining the rejection. */
  rejectionReason: string | null;
  /** Same-association form (optional). */
  linkedFormId: string | null;
  /** Poster/banner image URL (public, served via media-service). */
  imageUrl: string | null;
  /** Other associations co-managing this event. */
  coOwners: CalendarEventCoOwner[];
}

/** Row from `GET /api/associations/calendar/feed` (aggregated agenda). */
export interface AssociationCalendarFeedEvent extends AssociationCalendarEvent {
  associationName: string;
  associationSlug: string;
  /** Hex color set on the association, or null (frontend falls back to generateAvatarColor). */
  associationColor: string | null;
  /** Logo URL of the association (same-origin `/api/media/public/:id` path), or null. */
  associationLogoUrl: string | null;
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
  /** BDE / global admin only: create on behalf of another association. */
  targetAssocId?: string;
  /** IDs of associations co-managing this event (max 10). */
  coOwnerIds?: string[];
}

export interface UpdateAssociationCalendarEventPayload {
  title?: string;
  description?: string;
  startsAt?: string;
  endsAt?: string;
  linkedFormId?: string | null;
  /** Replaces the full co-owner list. Omit to leave unchanged. */
  coOwnerIds?: string[];
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

/** Media API base for resolving `/api/media/...` paths (Tauri needs an absolute URL). */
export function mediaPublicBaseUrl(): string {
  const fromEnv =
    typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_MEDIA_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  if (typeof window !== 'undefined') return window.location.origin.replace(/\/$/, '');
  return 'http://localhost:3011';
}

/** Resolve association logo URL for `<img src>` (handles relative `/api/...` paths). */
export function associationLogoSrc(logoUrl: string | null | undefined): string | null {
  if (!logoUrl?.trim()) return null;
  const u = logoUrl.trim();
  if (u.startsWith('/')) {
    return `${mediaPublicBaseUrl()}${u}`;
  }
  return u;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = socialUrl();
  const res = await apiFetch(`${base}${path}`, init as any);
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    let message = raw || res.statusText;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        'message' in parsed &&
        typeof (parsed as Record<string, unknown>).message === 'string'
      ) {
        message = (parsed as Record<string, string>).message;
      }
    } catch {
      // Ignore JSON parse failure: message is the raw error text
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
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

/** Rejects a pending calendar event with an optional reason (BDE or global admin only). */
export async function rejectAssociationCalendarEvent(
  associationId: string,
  eventId: string,
  reason?: string
): Promise<AssociationCalendarEvent> {
  return request<AssociationCalendarEvent>(
    `/api/associations/${encodeURIComponent(associationId)}/events/${encodeURIComponent(eventId)}/reject`,
    { method: 'POST', body: JSON.stringify({ reason: reason?.trim() || undefined }) }
  );
}

/**
 * Uploads a poster image for a calendar event.
 * Returns the updated event with the new `imageUrl`.
 */
export async function uploadCalendarEventImage(
  associationId: string,
  eventId: string,
  file: File
): Promise<AssociationCalendarEvent> {
  const base = socialUrl();
  const token = await getToken().catch(() => '');
  const fd = new FormData();
  fd.append('file', file);
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(
    `${base}/api/associations/${encodeURIComponent(associationId)}/events/${encodeURIComponent(eventId)}/image`,
    { method: 'POST', headers, body: fd }
  );
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`upload ${res.status}: ${details || res.statusText}`);
  }
  return (await res.json()) as AssociationCalendarEvent;
}

/** Removes the poster image from a calendar event. */
export async function deleteCalendarEventImage(
  associationId: string,
  eventId: string
): Promise<AssociationCalendarEvent> {
  return request<AssociationCalendarEvent>(
    `/api/associations/${encodeURIComponent(associationId)}/events/${encodeURIComponent(eventId)}/image`,
    { method: 'DELETE' }
  );
}

/** Response shape for the pending-events queue. */
export interface PendingCalendarEventsResponse {
  /** True when the caller has VALIDATE_EVENTS in a BDE association, or is global admin. */
  canValidate: boolean;
  events: AssociationCalendarFeedEvent[];
}

/** Pending events the caller may see, plus a flag indicating whether they can validate them. */
export async function listPendingCalendarEvents(): Promise<PendingCalendarEventsResponse> {
  return request<PendingCalendarEventsResponse>('/api/associations/calendar/pending');
}

/** Association admins - publications et formulaires récents pour lier un événement d’agenda. */
export async function listAssociationLinkCandidates(
  associationId: string
): Promise<AssociationLinkCandidates> {
  return request<AssociationLinkCandidates>(
    `/api/associations/${encodeURIComponent(associationId)}/link-candidates`
  );
}

/** Public - événement d’agenda pointant vers cette publication (fil). */
export async function getCalendarEventLinkedToPost(postId: string): Promise<{
  linkedEvent: AssociationCalendarEvent | null;
}> {
  return request<{ linkedEvent: AssociationCalendarEvent | null }>(
    `/api/posts/${encodeURIComponent(postId)}/calendar-link`
  );
}

/** Public - événement d’agenda pointant vers ce formulaire. */
export async function getCalendarEventLinkedToForm(formId: string): Promise<{
  linkedEvent: AssociationCalendarEvent | null;
}> {
  return request<{ linkedEvent: AssociationCalendarEvent | null }>(
    `/api/forms/${encodeURIComponent(formId)}/calendar-link`
  );
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

/** Updates the display order of members. Requires MANAGE_MEMBERS. `userIds` must be the full ordered list. */
export async function reorderMembers(associationId: string, userIds: string[]): Promise<void> {
  await request<void>(`/api/associations/${encodeURIComponent(associationId)}/members/reorder`, {
    method: 'PATCH',
    body: JSON.stringify({ userIds }),
  });
}

// ── Document vault ────────────────────────────────────────────────────────

export interface AssociationDocument {
  id: string;
  associationId: string;
  name: string;
  description: string | null;
  /** Only present when fetched via `GET /documents/:docId` (detail endpoint). */
  mediaId?: string;
  mimeType: string;
  size: number;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentVaultStats {
  documents: AssociationDocument[];
  usedBytes: number;
  quotaBytes: number;
}

export interface CreateDocumentPayload {
  name: string;
  description?: string;
  mediaId: string;
  mimeType: string;
  size: number;
}

/**
 * Returns the hex-encoded 32-byte vault key for the association.
 * The client uses this with HKDF to derive per-document AES-256-GCM keys.
 * Requires MANAGE_DOCUMENTS permission.
 */
export async function getVaultKey(associationId: string): Promise<string> {
  const res = await request<{ key: string }>(
    `/api/associations/${encodeURIComponent(associationId)}/vault-key`
  );
  return res.key;
}

/** Lists vault documents with quota usage stats. Requires MANAGE_DOCUMENTS. */
export async function listDocuments(associationId: string): Promise<DocumentVaultStats> {
  return request<DocumentVaultStats>(
    `/api/associations/${encodeURIComponent(associationId)}/documents`
  );
}

/**
 * Registers a new document in the vault.
 * Throws a 409 error object `{ conflict: true, existingDocId }` on name collision.
 * Throws a 413 error on quota exceeded.
 */
export async function createDocument(
  associationId: string,
  payload: CreateDocumentPayload
): Promise<AssociationDocument> {
  return request<AssociationDocument>(
    `/api/associations/${encodeURIComponent(associationId)}/documents`,
    { method: 'POST', body: JSON.stringify(payload) }
  );
}

/** Returns full document detail including mediaId for decryption. Requires MANAGE_DOCUMENTS. */
export async function getDocumentDetail(
  associationId: string,
  docId: string
): Promise<AssociationDocument> {
  return request<AssociationDocument>(
    `/api/associations/${encodeURIComponent(associationId)}/documents/${encodeURIComponent(docId)}`
  );
}

/** Deletes a document and its media blob. Requires MANAGE_DOCUMENTS. */
export async function deleteDocument(
  associationId: string,
  docId: string
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/api/associations/${encodeURIComponent(associationId)}/documents/${encodeURIComponent(docId)}`,
    { method: 'DELETE' }
  );
}

// ── Cotisation tags ─────────────────────────────────────────────────────────

/** A membership/cotisation tag granted to a user by an association. */
export interface UserTag {
  id: string;
  userId: string;
  tagName: string;
  issuingAssocId: string | null;
  grantedBy: string;
  expiresAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** Lists active tags issued by an association (requires MANAGE_MEMBERS). */
export async function listAssociationTags(associationId: string): Promise<UserTag[]> {
  return request<UserTag[]>(`/api/associations/${encodeURIComponent(associationId)}/tags`);
}

/** Manually grants a cotisation tag to a user (requires MANAGE_MEMBERS). */
export async function grantAssociationTag(
  associationId: string,
  data: { userId: string; tagName: string; expiresAt?: string }
): Promise<UserTag> {
  return request<UserTag>(`/api/associations/${encodeURIComponent(associationId)}/tags`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/** Revokes a cotisation tag (requires MANAGE_MEMBERS). */
export async function revokeAssociationTag(associationId: string, tagId: string): Promise<void> {
  await request<unknown>(
    `/api/associations/${encodeURIComponent(associationId)}/tags/${encodeURIComponent(tagId)}`,
    { method: 'DELETE' }
  );
}

// ── Boutique products ───────────────────────────────────────────────────────

export interface AssociationProduct {
  id: string;
  associationId: string;
  name: string;
  description: string | null;
  /** Fixed price in cents; null when only custom amounts are allowed. */
  amountCents: number | null;
  currency: string;
  type: 'membership' | 'balance_topup' | 'other';
  grantedTagName: string | null;
  tagExpiresAt: string | null;
  allowCustomAmount: boolean;
  customAmountMinCents: number | null;
  customAmountMaxCents: number | null;
  /** webhookUrl and webhookSecret are never returned by the API. */
  isActive: boolean;
  sortOrder: number;
  allowRepeatPurchase: boolean;
  maxPurchasesPerUser: number | null;
  maxPurchasesTotal: number | null;
  createdAt: string;
  updatedAt: string;
}

/** A completed purchase with buyer display name. */
export interface AssociationPurchase {
  id: string;
  userId: string;
  source: 'form' | 'product';
  productId: string | null;
  formId: string | null;
  productName: string;
  amountCents: number;
  paymentMethod: 'stripe' | 'cash';
  paidAt: string;
  firstName: string | null;
  lastName: string | null;
}

/** @deprecated Use AssociationPurchase — kept for per-product endpoint compatibility. */
export type ProductPurchase = AssociationPurchase;

export interface CreateProductPayload {
  name: string;
  description?: string;
  amountCents?: number;
  currency?: string;
  type: 'membership' | 'balance_topup' | 'other';
  grantedTagName?: string;
  tagExpiresAt?: string;
  allowCustomAmount?: boolean;
  customAmountMinCents?: number;
  customAmountMaxCents?: number;
  webhookUrl?: string;
  webhookSecret?: string;
  isActive?: boolean;
  sortOrder?: number;
  allowRepeatPurchase?: boolean;
  maxPurchasesPerUser?: number | null;
  maxPurchasesTotal?: number | null;
}

export type UpdateProductPayload = Partial<CreateProductPayload> & {
  maxPurchasesPerUser?: number | null;
  maxPurchasesTotal?: number | null;
};

/** Returns all active products across all associations (login required). */
export async function listAllProducts(): Promise<AssociationProduct[]> {
  return request<AssociationProduct[]>('/api/associations/products/all');
}

/** Returns active products for a single association (public). */
export async function listAssociationProducts(
  associationId: string
): Promise<AssociationProduct[]> {
  return request<AssociationProduct[]>(
    `/api/associations/${encodeURIComponent(associationId)}/products`
  );
}

/** Returns all products including inactive (requires MANAGE_PRODUCTS). */
export async function listAssociationProductsForManage(
  associationId: string
): Promise<AssociationProduct[]> {
  return request<AssociationProduct[]>(
    `/api/associations/${encodeURIComponent(associationId)}/products/manage`
  );
}

export interface GrantProductPurchasePayload {
  userId: string;
  /** Amount in cents; required when the product has no fixed price. */
  amountCents?: number;
}

/**
 * Manually records a product purchase for a user (cash, retroactive grant).
 * Requires MANAGE_PRODUCTS.
 */
export async function grantProductPurchase(
  associationId: string,
  productId: string,
  payload: GrantProductPurchasePayload
): Promise<AssociationPurchase> {
  const row = await request<AssociationPurchase>(
    `/api/associations/${encodeURIComponent(associationId)}/products/${encodeURIComponent(productId)}/grant`,
    { method: 'POST', body: JSON.stringify(payload) }
  );
  return row;
}

/** Lists all paid purchases for an association (requires MANAGE_PRODUCTS). */
export async function listAssociationPurchases(
  associationId: string
): Promise<AssociationPurchase[]> {
  return request<AssociationPurchase[]>(
    `/api/associations/${encodeURIComponent(associationId)}/purchases`
  );
}

/** Lists buyers for a boutique product (requires MANAGE_PRODUCTS). */
export async function listProductPurchases(
  associationId: string,
  productId: string
): Promise<AssociationPurchase[]> {
  return request<AssociationPurchase[]>(
    `/api/associations/${encodeURIComponent(associationId)}/products/${encodeURIComponent(productId)}/purchases`
  );
}

/** Creates a new product in the association's boutique (requires MANAGE_PRODUCTS). */
export async function createProduct(
  associationId: string,
  payload: CreateProductPayload
): Promise<AssociationProduct> {
  return request<AssociationProduct>(
    `/api/associations/${encodeURIComponent(associationId)}/products`,
    { method: 'POST', body: JSON.stringify(payload) }
  );
}

/** Updates a product (requires MANAGE_PRODUCTS). */
export async function updateProduct(
  associationId: string,
  productId: string,
  payload: UpdateProductPayload
): Promise<AssociationProduct> {
  return request<AssociationProduct>(
    `/api/associations/${encodeURIComponent(associationId)}/products/${encodeURIComponent(productId)}`,
    { method: 'PATCH', body: JSON.stringify(payload) }
  );
}

/** Deletes a product (requires MANAGE_PRODUCTS). */
export async function deleteProduct(associationId: string, productId: string): Promise<void> {
  await request<unknown>(
    `/api/associations/${encodeURIComponent(associationId)}/products/${encodeURIComponent(productId)}`,
    { method: 'DELETE' }
  );
}

/**
 * Creates a Stripe Checkout session for a product purchase.
 * Returns the Stripe-hosted checkout URL to redirect the user to.
 */
export async function createProductCheckout(
  associationId: string,
  productId: string,
  customAmountCents?: number,
  callbacks?: { successUrl?: string; cancelUrl?: string }
): Promise<{ checkoutUrl: string; amountCents: number; currency: string }> {
  return request<{ checkoutUrl: string; amountCents: number; currency: string }>(
    `/api/associations/${encodeURIComponent(associationId)}/products/${encodeURIComponent(productId)}/checkout`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...(customAmountCents !== undefined ? { customAmountCents } : {}),
        ...(callbacks?.successUrl ? { successUrl: callbacks.successUrl } : {}),
        ...(callbacks?.cancelUrl ? { cancelUrl: callbacks.cancelUrl } : {}),
      }),
    }
  );
}

export interface WebhookDelivery {
  id: string;
  productId: string;
  userId: string;
  amountCents: number;
  paymentIntentId: string;
  status: 'pending' | 'delivered' | 'failed';
  attemptCount: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
}

/** Lists failed Cercle webhook deliveries (requires MANAGE_PRODUCTS). */
export async function listWebhookFailures(associationId: string): Promise<WebhookDelivery[]> {
  return request<WebhookDelivery[]>(
    `/api/associations/${encodeURIComponent(associationId)}/webhook-failures`
  );
}

/** Retries a failed Cercle webhook delivery (requires MANAGE_PRODUCTS). */
export async function retryWebhookDelivery(
  associationId: string,
  deliveryId: string
): Promise<void> {
  await request<unknown>(
    `/api/associations/${encodeURIComponent(associationId)}/webhook-failures/${encodeURIComponent(deliveryId)}/retry`,
    { method: 'POST' }
  );
}

// ── Forms (MANAGE_FORMS) ────────────────────────────────────────────────────

/** Lean form summary returned by GET /associations/:id/forms. */
export interface AssociationForm {
  id: string;
  title: string;
  description: string | null;
  basePrice: number;
  currency: string;
  allowCashPayment: boolean;
  createdAt: string;
}

/** Returns all forms linked to an association (requires MANAGE_FORMS flag). */
export async function listAssociationForms(associationId: string): Promise<AssociationForm[]> {
  return request<AssociationForm[]>(`/api/associations/${encodeURIComponent(associationId)}/forms`);
}

// ── Stripe Connect status ───────────────────────────────────────────────────

/** Treasurer-facing Stripe Connect lifecycle (mirrors core-service). */
export type StripeConnectStatus =
  | 'not_started'
  | 'onboarding_required'
  | 'pending'
  | 'active'
  | 'restricted'
  | 'unavailable';

/** Stripe Connect balance for a connected association account. */
export interface StripeConnectBalance {
  availableCents: number;
  pendingCents: number;
  currency: string;
}

export interface StripeConnectStatusResult {
  status: StripeConnectStatus;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  detailsSubmitted?: boolean;
  currentlyDue?: string[];
  pendingVerification?: string[];
  disabledReason?: string | null;
  stripeAccountId?: string | null;
  dbOnboardingComplete?: boolean;
  balance?: StripeConnectBalance | null;
  message?: string;
}

/** Formats a Connect balance amount for display. */
export function formatStripeConnectAmount(cents: number, currency: string): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

/** True when the association can accept online payments (live or DB flag). */
export function isStripeConnectReady(
  status: StripeConnectStatusResult | null | undefined
): boolean {
  if (!status) return false;
  return status.status === 'active' || !!status.dbOnboardingComplete;
}

/**
 * True when an association may be selected as recipient for paid forms.
 * Requires Stripe Connect onboarding complete (not merely a linked account id).
 */
export function canAssociationReceiveFormPayments(asso: Association): boolean {
  return asso.stripeOnboardingComplete === true;
}

/** Fetches live Stripe Connect status (requires MANAGE_STRIPE_CONNECT). */
export async function fetchStripeConnectStatus(
  associationId: string
): Promise<StripeConnectStatusResult> {
  const base = coreUrl();
  const res = await apiFetch(
    `${base}/api/payments/connect-status/${encodeURIComponent(associationId)}`
  );
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`connect-status ${res.status}: ${details || res.statusText}`);
  }
  return (await res.json()) as StripeConnectStatusResult;
}

/**
 * Opens the association's Stripe Connect dashboard (payouts, bank account).
 * Requires MANAGE_STRIPE_CONNECT.
 */
export async function openStripeConnectDashboard(associationId: string): Promise<string> {
  const base = coreUrl();
  const res = await apiFetch(
    `${base}/api/payments/connect-dashboard-link/${encodeURIComponent(associationId)}`,
    { method: 'POST' }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { message?: string })?.message || `Dashboard link failed (${res.status})`
    );
  }
  const data = (await res.json()) as { url: string };
  if (!data.url) throw new Error('Stripe did not return a dashboard URL');
  return data.url;
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
