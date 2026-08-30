import { apiFetch } from '$lib/utils/apiFetch';
import { getToken } from '$lib/stores/auth';
import { coreUrl, socialUrl } from '$lib/utils/apiUrl';
import { setAssociationSuperAdmin, setContentModerator } from '$lib/stores/userState.svelte';
import { downloadDecryptedFile } from '$lib/utils/fileDownload';
// Type-only: `carte/publish` transitively imports this module, so a value import would cycle.
import type { PublishedCarte } from '$lib/carte/publish';

/**
 * Permission flags for association members (mirrors the backend enum).
 * Combine flags with bitwise OR; test with `(permissions & flag) !== 0`.
 */
export enum AssociationPermissionFlag {
  POST_AS_ASSO = 1 << 0,
  PROPOSE_EVENT = 1 << 1,
  MANAGE_MEMBERS = 1 << 2,
  MANAGE_DOCUMENTS = 1 << 3,
  MANAGE_FORMS = 1 << 4,
  VALIDATE_EVENTS = 1 << 5,
  MANAGE_ASSO = 1 << 6,
  MODERATE = 1 << 7,
  MANAGE_PRODUCTS = 1 << 8,
  MANAGE_STRIPE_CONNECT = 1 << 9,
  MANAGE_PARTNERSHIPS = 1 << 10,
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
  AssociationPermissionFlag.MANAGE_PRODUCTS |
  AssociationPermissionFlag.MANAGE_PARTNERSHIPS;

/** Default admin preset when adding a member (core flags + Stripe Connect). */
export const ASSOCIATION_ADMIN_PRESET =
  ALL_CORE_FLAGS | AssociationPermissionFlag.MANAGE_STRIPE_CONNECT;

/** Returns true if `permissions` includes `flag`. */
export function hasPermissionFlag(permissions: number, flag: AssociationPermissionFlag): boolean {
  return (permissions & flag) !== 0;
}

/**
 * Flags a cross-association super-admin (a BDE member holding `MANAGE_ASSO`) does NOT inherit on
 * an association they are not a member of. Mirrors the backend `SUPER_ADMIN_EXCLUDED_FLAGS`, which
 * carries the reasoning: `MANAGE_ASSO` grants administration, and neither an association's bank
 * account nor its voice is administration.
 */
export const SUPER_ADMIN_EXCLUDED_FLAGS =
  AssociationPermissionFlag.MANAGE_STRIPE_CONNECT | AssociationPermissionFlag.POST_AS_ASSO;

/**
 * Flags that only mean anything inside a BDE association - the server enforces `a.isBDE = true`
 * in every query that honours them, so granting one elsewhere is inert. Exported so the members
 * editor hides them from non-BDE associations without re-listing them by hand.
 */
export const BDE_ONLY_FLAGS: ReadonlySet<AssociationPermissionFlag> = new Set([
  AssociationPermissionFlag.VALIDATE_EVENTS,
  AssociationPermissionFlag.MANAGE_ASSO,
  AssociationPermissionFlag.MODERATE,
]);

/**
 * May the current user exercise `flag` on one association? The client mirror of the server's
 * `AssociationsService.mayAct`, and the ONLY shape any screen should use to gate an association
 * control.
 *
 * Three tiers, widest first: the platform administrator, who holds every association right whether
 * or not they are a member; the cross-association super-admin, minus `SUPER_ADMIN_EXCLUDED_FLAGS`;
 * then the user's own bitmask in that association. `memberPermissions` is undefined for a
 * non-member - and never for the caller's own row, which `listMembers` always returns in full.
 *
 * It exists because the same three-line expression was written out six times on the association
 * edit page alone, once WITHOUT the super-admin tier - which is how a control the API accepts came
 * to be hidden from the person allowed to use it.
 */
export function mayActOnAssociation(
  flag: AssociationPermissionFlag,
  ctx: { isGlobalAdmin: boolean; isSuperAdmin: boolean; memberPermissions?: number }
): boolean {
  if (ctx.isGlobalAdmin) return true;
  if (ctx.isSuperAdmin && (flag & SUPER_ADMIN_EXCLUDED_FLAGS) === 0) return true;
  return hasPermissionFlag(ctx.memberPermissions ?? 0, flag);
}

/**
 * The user's BDE association granting `flag`, or undefined. The id matters as much as the verdict:
 * a BDE-wide right is exercised through the route of the BDE association that carries it, so the
 * caller needs to know WHICH one.
 */
export function findBdeAssociationWithFlag(
  myAssociations: Association[],
  flag: AssociationPermissionFlag
): Association | undefined {
  return myAssociations.find((a) => a.isBDE && hasPermissionFlag(a.permissions ?? 0, flag));
}

/** Whether any of the user's BDE associations grants `flag`. */
export function holdsBdeFlag(
  myAssociations: Association[],
  flag: AssociationPermissionFlag
): boolean {
  return !!findBdeAssociationWithFlag(myAssociations, flag);
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
  /** Lydia Business vendor_token - own column, independent from the Stripe pair above. */
  lydiaAccountId: string | null;
  lydiaOnboardingComplete: boolean;
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
  /** Primary thematic category (managed table). Null when uncategorized. Used by the "Carte de la Vie Asso" poster. */
  categoryId?: string | null;
  /** Discriminates a regular association from a promo list. */
  type: 'association' | 'list';
  /** Lists only: the promotion year the list belongs to. */
  promo?: number | null;
  /** Lists only: optional parent association (e.g. the owning BDE). */
  parentAssociationId?: string | null;
  /** Lists only: display name of the parent association, when resolved by the API. */
  parentName?: string | null;
  /** Lists only: optional second theme name (some lists run two themes). */
  name2?: string | null;
  /** Lists only: optional second theme logo (media-service UUID). */
  logoMediaId2?: string | null;
  /** True when archived: shown under "Anciennes", hidden from "Mes associations". */
  archived: boolean;
  /** Public contact e-mail, shown on the trombinoscope and the association page. */
  contactEmail?: string | null;
  /** Reveals the Cotisations admin tab and cotisation config. */
  cotisationEnabled?: boolean;
  /** Validity mode of the cotisation: buy-once (`lifetime`) or renewed yearly (`dated`). Null when disabled. */
  cotisationMode?: 'lifetime' | 'dated' | null;
  /** Deadline for the current `dated` period (31/08 of the academic year). Null for `lifetime` or when disabled. */
  cotisationExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAssociationPayload {
  name: string;
  slug: string;
  description?: string;
  bioMarkdown?: string;
  logoUrl?: string;
  contactEmail?: string;
  /** 'association' (default) or 'list'. */
  type?: 'association' | 'list';
  /** Lists only: the promotion year. */
  promo?: number;
  /** Lists only: optional parent association. */
  parentAssociationId?: string;
  /** Lists only: optional second theme name. */
  name2?: string;
  /** Lists only: optional second theme logo (media-service UUID). */
  logoMediaId2?: string;
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
  /** Primary thematic category id. Pass `""` or `null` to clear. */
  categoryId?: string | null;
  /** Archive/unarchive the association. */
  archived?: boolean;
  /** Public contact e-mail. Pass `""` or `null` to clear. */
  contactEmail?: string | null;
  /** Lists only: the promotion year. */
  promo?: number | null;
  /** Lists only: optional parent association. */
  parentAssociationId?: string | null;
  /** Lists only: optional second theme name. Pass `""` to clear. */
  name2?: string | null;
  /** Lists only: optional second theme logo. Pass `""`/null to clear. */
  logoMediaId2?: string | null;
  /** Reveals the Cotisations admin tab (requires MANAGE_PRODUCTS server-side). */
  cotisationEnabled?: boolean;
  /** Validity mode of the cotisation. Required when enabling; pass `null` to clear when disabling. */
  cotisationMode?: 'lifetime' | 'dated' | null;
  /** Deadline for the current `dated` period, as an ISO string. Pass `null` to clear. */
  cotisationExpiresAt?: string | null;
}

export type AssociationCalendarEventStatus = 'pending' | 'validated' | 'rejected';

/**
 * Visual kind of a calendar entry.
 * - `event`: a normal event card occupying an event slot.
 * - `break`: a no-course / vacation / holiday period, drawn as a full-day background band behind
 *   events and not occupying an event slot (purely graphical).
 */
export type AssociationCalendarEventKind = 'event' | 'break';

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
  /** Visual kind: `event` (card) or `break` (full-day background band). */
  kind: AssociationCalendarEventKind;
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
  /** `event` (default) or `break` (a full-day background band). */
  kind?: AssociationCalendarEventKind;
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
  /** `event` or `break` (a full-day background band). */
  kind?: AssociationCalendarEventKind;
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

/** Media API base for resolving `/api/media/…` paths (Tauri needs an absolute URL). */
export function mediaPublicBaseUrl(): string {
  const fromEnv =
    typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_MEDIA_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  if (typeof window !== 'undefined') return window.location.origin.replace(/\/$/, '');
  return 'http://localhost:3011';
}

/** Resolve association logo URL for `<img src>` (handles relative `/api/…` paths). */
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
  // A successful response is not always JSON: DELETEs and void POSTs answer 204, or 200 with an
  // empty body. `res.json()` on those throws "unexpected end of data", turning a call that WORKED
  // into a visible error - and, worse, skipping whatever the caller does after it (a revoked
  // cotisant stayed listed because the row removal never ran).
  if (res.status === 204) return undefined as T;
  const raw = await res.text();
  return (raw ? JSON.parse(raw) : undefined) as T;
}

// ── Public ────────────────────────────────────────────────────────────────

/** Lists associations. Pass `type` to restrict to regular associations or promo lists. */
export async function listAssociations(type?: 'association' | 'list'): Promise<Association[]> {
  const qs = type ? `?type=${type}` : '';
  return request<Association[]>(`/api/associations${qs}`);
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
  opts?: { from?: string; to?: string; includePending?: boolean; includeRejected?: boolean }
): Promise<AssociationCalendarEvent[]> {
  const q = new URLSearchParams();
  if (opts?.from) q.set('from', opts.from);
  if (opts?.to) q.set('to', opts.to);
  if (opts?.includePending) q.set('includePending', 'true');
  if (opts?.includeRejected) q.set('includeRejected', 'true');
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
  /** Opt-in: includes pending events (honoured only for proposers/BDE/admin). Never passed for the PDF export. */
  includePending?: boolean;
}): Promise<AssociationCalendarFeedEvent[]> {
  const q = new URLSearchParams();
  q.set('from', opts.from);
  q.set('to', opts.to);
  if (opts.associationId?.trim()) q.set('associationId', opts.associationId.trim());
  if (opts.includePending) q.set('includePending', 'true');
  return request<AssociationCalendarFeedEvent[]>(`/api/associations/calendar/feed?${q.toString()}`);
}

/**
 * Default window for an `.ics` subscription link: 3 months back to the end of the 12th month
 * ahead. The backend defaults to the same range when `from`/`to` are omitted, but a subscribe
 * link is built once and copied/saved by the user, so we still send an explicit window here -
 * it reads better in a calendar app's "range of this subscription" UI than a bare URL would.
 */
export function icsSubscriptionRangeISO(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 3, 1, 0, 0, 0, 0);
  const to = new Date(now.getFullYear(), now.getMonth() + 12, 0, 23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
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

/** Association admins - recent posts and forms, used to link a calendar event. */
export async function listAssociationLinkCandidates(
  associationId: string
): Promise<AssociationLinkCandidates> {
  return request<AssociationLinkCandidates>(
    `/api/associations/${encodeURIComponent(associationId)}/link-candidates`
  );
}

/** Public - calendar event pointing to this post (feed). */
export async function getCalendarEventLinkedToPost(postId: string): Promise<{
  linkedEvent: AssociationCalendarEvent | null;
}> {
  return request<{ linkedEvent: AssociationCalendarEvent | null }>(
    `/api/posts/${encodeURIComponent(postId)}/calendar-link`
  );
}

/** Public - the calendar event pointing at this form, if any. */
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

/** Session cache for the membership probe; deduplicates concurrent callers. */
let myAssociationsProbe: Promise<Association[]> | null = null;

/**
 * Loads the caller's memberships once per session and publishes EVERY BDE-derived flag from that
 * one answer.
 *
 * One request rather than one per flag: the screens that need these ask for several at once - the
 * admin layout wants the super-admin and the moderator tier in the same breath - and two caches
 * over the same endpoint would drift the moment one is force-refreshed and the other is not.
 *
 * A failure is a refusal of every flag, and it is logged: a silently empty membership list is
 * indistinguishable from a user who belongs to nothing, and would hide a control with no trace.
 */
export async function ensureMyAssociations(force = false): Promise<Association[]> {
  if (force) myAssociationsProbe = null;
  if (!myAssociationsProbe) {
    myAssociationsProbe = listMyAssociations()
      .then((assos) => {
        setAssociationSuperAdmin(holdsBdeFlag(assos, AssociationPermissionFlag.MANAGE_ASSO));
        setContentModerator(holdsBdeFlag(assos, AssociationPermissionFlag.MODERATE));
        return assos;
      })
      .catch((err) => {
        console.error('[associations] membership probe failed, every BDE flag denied', err);
        setAssociationSuperAdmin(false);
        setContentModerator(false);
        return [];
      });
  }
  return myAssociationsProbe;
}

/**
 * Determines whether the current user is a cross-association super-admin (member of a BDE
 * association holding `MANAGE_ASSO`) and publishes it to the reactive user state so
 * `isAssociationSuperAdmin()` reflects it. Cached for the session; pass `force` to re-probe (e.g.
 * after a permission change).
 */
export async function ensureAssociationSuperAdmin(force = false): Promise<boolean> {
  return holdsBdeFlag(await ensureMyAssociations(force), AssociationPermissionFlag.MANAGE_ASSO);
}

/**
 * Determines whether the current user may moderate content platform-wide (member of a BDE
 * association holding `MODERATE`) and publishes it so `isContentModerator()` reflects it.
 *
 * The client mirror of the server's `isContentModerator`: the moderation screen and the server's
 * guards must open to the same people, or the tier is reachable only by whoever knows the URL.
 */
export async function ensureContentModerator(force = false): Promise<boolean> {
  return holdsBdeFlag(await ensureMyAssociations(force), AssociationPermissionFlag.MODERATE);
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
  /** `private` = association only; `public` = also visible to document reviewers. */
  visibility: 'private' | 'public';
  /** Original uploaded file name (with extension), preserved across renames. */
  originalFilename?: string | null;
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
  /** Original uploaded file name (with extension), preserved for downloads. */
  originalFilename?: string;
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

/** Returns the association's vault-encrypted shared notepad ciphertext (base64, empty if unset). */
export async function getAssociationNotesCiphertext(associationId: string): Promise<string> {
  const res = await request<{ ciphertext: string }>(
    `/api/associations/${encodeURIComponent(associationId)}/notes`
  );
  return res.ciphertext ?? '';
}

/** Stores the association's vault-encrypted shared notepad ciphertext (base64). */
export async function saveAssociationNotesCiphertext(
  associationId: string,
  ciphertext: string
): Promise<void> {
  await request(`/api/associations/${encodeURIComponent(associationId)}/notes`, {
    method: 'PUT',
    body: JSON.stringify({ ciphertext }),
  });
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

/**
 * Renames a document (display name) and/or changes its visibility (private/public).
 * Rejected (400) when making a password-protected document public. Requires MANAGE_DOCUMENTS.
 */
export async function updateDocument(
  associationId: string,
  docId: string,
  patch: { name?: string; visibility?: 'private' | 'public' }
): Promise<AssociationDocument> {
  return request<AssociationDocument>(
    `/api/associations/${encodeURIComponent(associationId)}/documents/${encodeURIComponent(docId)}`,
    { method: 'PATCH', body: JSON.stringify(patch) }
  );
}

// ── Document reviewers (cross-association public-document access) ─────────────

/** A global document-reviewer grant (school / Maison des eleves staff). */
export interface DocumentReviewerGrant {
  userId: string;
  grantedBy: string;
  createdAt: string;
}

/** A public document exposed to a reviewer, with its server-derived hex CEK. */
export interface ReviewerDocument {
  id: string;
  name: string;
  originalFilename: string | null;
  mimeType: string;
  size: number;
  mediaId: string;
  cek: string;
  createdAt: string;
}

/** Public documents of one association for the cross-association reviewer page. */
export interface ReviewerDocumentGroup {
  associationId: string;
  associationName: string;
  slug: string;
  logoUrl: string | null;
  documents: ReviewerDocument[];
}

/** Probe whether the current user may access the cross-association reviewer page. */
export async function getReviewerAccess(): Promise<boolean> {
  const res = await request<{ hasAccess: boolean }>('/api/associations/reviewer/access');
  return res.hasAccess;
}

/** Lists every association's public documents (reviewer-gated). */
export async function listReviewerDocuments(): Promise<ReviewerDocumentGroup[]> {
  return request<ReviewerDocumentGroup[]>('/api/associations/reviewer/documents');
}

/** Lists all document-reviewer grants. Global admins / BDE super-admins only. */
export async function listDocumentReviewers(): Promise<DocumentReviewerGrant[]> {
  return request<DocumentReviewerGrant[]>('/api/associations/document-reviewers');
}

/** Grants document-reviewer access to a user. Global admins / BDE super-admins only. */
export async function addDocumentReviewer(userId: string): Promise<DocumentReviewerGrant> {
  return request<DocumentReviewerGrant>('/api/associations/document-reviewers', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
}

/** Revokes a user's document-reviewer access. Global admins / BDE super-admins only. */
export async function removeDocumentReviewer(userId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/api/associations/document-reviewers/${encodeURIComponent(userId)}`,
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

// ── Cotisant roster ──────────────────────────────────────────────────────────

/** A single row of the association's active cotisant roster (promo-sorted, "Sans promo" last). */
export interface CotisantRosterItem {
  tagId: string;
  userId: string;
  tagName: string;
  grantedAt: string;
  expiresAt: string | null;
  firstName: string | null;
  lastName: string | null;
  /** Promotion year, or null for cotisants without one (externals, staff) - grouped last. */
  promo: number | null;
  /** Tier product name (e.g. "Avec alcool") for multi-tier associations; null for the base tier. */
  tier: string | null;
}

/** One paginated page of the cotisant roster. */
export interface CotisantRosterPage {
  items: CotisantRosterItem[];
  total: number;
  hasMore: boolean;
}

/** Lists the active cotisant roster for an association, paginated and searchable (requires MANAGE_MEMBERS). */
export async function listCotisants(
  associationId: string,
  opts: { search?: string; offset?: number; limit?: number } = {}
): Promise<CotisantRosterPage> {
  const params = new URLSearchParams();
  if (opts.search?.trim()) params.set('search', opts.search.trim());
  if (opts.offset != null) params.set('offset', String(opts.offset));
  if (opts.limit != null) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return request<CotisantRosterPage>(
    `/api/associations/${encodeURIComponent(associationId)}/cotisants${qs ? `?${qs}` : ''}`
  );
}

/** One cotisation tier of an association, as offered by its membership products. */
export interface CotisationTier {
  /** Named tier key (e.g. "avec-alcool"), or null for the base, un-suffixed tier. */
  variantKey: string | null;
  /** Membership product display name, e.g. "Avec alcool". */
  name: string;
  /** Tag this tier grants for the current academic year. */
  tagName: string;
}

/**
 * Lists the association's cotisation tiers so the roster can offer them when adding a cotisant.
 * Requires MANAGE_MEMBERS (not MANAGE_PRODUCTS) - whoever manages the roster must be able to
 * pick a forfait without also being allowed to edit the boutique.
 */
export async function listCotisationTiers(associationId: string): Promise<CotisationTier[]> {
  return request<CotisationTier[]>(
    `/api/associations/${encodeURIComponent(associationId)}/cotisation-tiers`
  );
}

/** A cotisation tier as a form configurator sees it: a name to choose between, and nothing else. */
export interface MembershipTier {
  /** Names the tier on the wire; never shown to anyone. `null` is the base, un-suffixed tier. */
  variantKey: string | null;
  /** The tier's display name, e.g. "Avec alcool" - the ONLY part a screen may render. */
  name: string;
}

/** What the caller may do with an association's cotisations, from the forms admin's point of view. */
export interface CotisationOptions {
  /** The tiers the association sells, base tier first. Empty when it runs no cotisation. */
  tiers: MembershipTier[];
  /**
   * Whether the caller may hand one of them out (MANAGE_MEMBERS) - the same right the manual roster
   * add needs, because a form that grants a cotisation on payment does the same thing.
   */
  mayGrant: boolean;
}

/**
 * Reads an association's cotisation tiers, and whether the caller may grant them.
 *
 * Deliberately not `listCotisationTiers`: that one requires MANAGE_MEMBERS, which a form manager
 * (MANAGE_FORMS) need not hold, and it carries the derived tag - which no screen has any use for.
 */
export async function fetchCotisationOptions(associationId: string): Promise<CotisationOptions> {
  return request<CotisationOptions>(
    `/api/associations/${encodeURIComponent(associationId)}/cotisation-options`
  );
}

/**
 * Manually grants one of the association's cotisation tiers to a user (D10: tag only, no
 * purchase/amount recorded). The tag name is derived server-side from `variantKey`; omit it for a
 * single-tier association. Granting a tier revokes the user's other tiers. Requires MANAGE_MEMBERS.
 */
export async function grantCotisant(
  associationId: string,
  userId: string,
  variantKey?: string | null
): Promise<UserTag> {
  return request<UserTag>(`/api/associations/${encodeURIComponent(associationId)}/cotisants`, {
    method: 'POST',
    body: JSON.stringify({ userId, variantKey: variantKey || undefined }),
  });
}

/**
 * Fetches an XLSX endpoint and triggers a browser download. The filename is taken from the
 * response's `Content-Disposition` header (RFC 5987 `filename*` preferred, ASCII `filename`
 * fallback), or `fallbackName` when the header is absent. Requires the caller to be authorized
 * for the endpoint.
 */
async function downloadXlsxFromApi(path: string, fallbackName: string): Promise<void> {
  const res = await apiFetch(`${socialUrl()}${path}`);
  if (!res.ok) {
    throw new Error(`Failed to export (${res.status})`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const asciiMatch = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = utf8Match
    ? decodeURIComponent(utf8Match[1])
    : asciiMatch
      ? asciiMatch[1]
      : fallbackName;
  await downloadDecryptedFile(blob, filename);
}

/**
 * Downloads the association's cotisant roster as an .xlsx file and triggers a browser download.
 * Requires MANAGE_MEMBERS.
 */
export async function exportCotisants(associationId: string): Promise<void> {
  await downloadXlsxFromApi(
    `/api/associations/${encodeURIComponent(associationId)}/cotisants/export`,
    'cotisants.xlsx'
  );
}

/**
 * Downloads the association's completed purchases (boutique + paid forms) as an .xlsx file.
 * Requires MANAGE_PRODUCTS.
 */
export async function exportAssociationPurchases(associationId: string): Promise<void> {
  await downloadXlsxFromApi(
    `/api/associations/${encodeURIComponent(associationId)}/purchases/export`,
    'achats.xlsx'
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
  /** Reserved to holders of the association's active cotisation tag. */
  membersOnly: boolean;
  /** Reduced price in cents for cotisants; null = same as amountCents. */
  amountCentsMember: number | null;
  /**
   * True when the requesting user holds ANY active tier tag of this product's association.
   * Set only by `listAllProducts` (`/products/all`, shop); undefined on admin/public listings.
   */
  viewerIsCotisant?: boolean;
  /**
   * The variantKey of the tier the viewer currently holds for this product's association, if
   * any (null for a single-tier association or when the viewer holds no tag). Set only by
   * `listAllProducts`, same as `viewerIsCotisant`.
   */
  viewerActiveTier?: string | null;
  /** Arbitrary tag names gating purchase eligibility (buyer must hold ANY). Overrides `membersOnly`. */
  requiredTags: string[] | null;
  /** Named cotisation tier (e.g. "avec-alcool"), suffixed onto the derived cotisation tag. Null = base/single tier. */
  variantKey: string | null;
  /** Ordinal rank of this tier for future "tier >= N" checks (WP-COT-8, unused today). */
  variantLevel: number | null;
  /** Sibling tier's granted tag that qualifies the buyer for `amountCentsMember` (tier upgrade pricing). */
  memberPriceTag: string | null;
  allowCustomAmount: boolean;
  customAmountMinCents: number | null;
  customAmountMaxCents: number | null;
  /** Cercle webhook endpoint (`balance_topup`); not a secret, so it is returned as configured. */
  webhookUrl: string | null;
  /**
   * Whether an HMAC signing secret is set. The secret ITSELF is never returned - the server
   * replaces it with this flag, so the admin page can say "configured" without holding the key.
   */
  webhookConfigured: boolean;
  isActive: boolean;
  /** Decorative icon shown on the product's card (e.g. a partner brand's logo); null = type-based fallback. */
  iconUrl: string | null;
  /** Short decorative label shown as a pill on the card (e.g. "Nouveau", "-20%"); null = no badge. */
  badgeText: string | null;
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

/** @deprecated Use AssociationPurchase - kept for per-product endpoint compatibility. */
export type ProductPurchase = AssociationPurchase;

export interface CreateProductPayload {
  name: string;
  description?: string;
  amountCents?: number;
  currency?: string;
  type: 'membership' | 'balance_topup' | 'other';
  grantedTagName?: string;
  tagExpiresAt?: string;
  /** Reserved to holders of the association's active cotisation tag. */
  membersOnly?: boolean;
  /** Reduced price in cents for cotisants (defaults to `amountCents` when omitted). */
  amountCentsMember?: number;
  /** Named cotisation tier (e.g. "avec-alcool"); only meaningful for `type: 'membership'`. */
  variantKey?: string;
  /** Ordinal rank of this tier for future "tier >= N" checks (WP-COT-8, unused today). */
  variantLevel?: number;
  /** Sibling tier's granted tag that qualifies the buyer for `amountCentsMember` (tier upgrade pricing). */
  memberPriceTag?: string;
  /** Arbitrary tag names gating purchase eligibility (buyer must hold ANY). Overrides `membersOnly`. */
  requiredTags?: string[];
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

export type UpdateProductPayload = Omit<
  Partial<CreateProductPayload>,
  | 'amountCents'
  | 'amountCentsMember'
  | 'customAmountMinCents'
  | 'customAmountMaxCents'
  | 'memberPriceTag'
  | 'requiredTags'
  | 'variantKey'
> & {
  maxPurchasesPerUser?: number | null;
  maxPurchasesTotal?: number | null;
  /** Pass null to clear the fixed price (custom-amount-only products). */
  amountCents?: number | null;
  /** Pass null to charge cotisants the same as everyone. */
  amountCentsMember?: number | null;
  /** Pass null to clear the custom-amount minimum. */
  customAmountMinCents?: number | null;
  /** Pass null to clear the custom-amount maximum. */
  customAmountMaxCents?: number | null;
  /** Pass null to remove the upgrade-pricing link to a sibling tier. */
  memberPriceTag?: string | null;
  /** Pass null to clear the eligibility-gating tag list. */
  requiredTags?: string[] | null;
  /**
   * Renames the tier. The server re-derives the granted tag and migrates the cotisants already
   * holding the old one, so a base tier can be converted into a named forfait. Null = base tier.
   */
  variantKey?: string | null;
  /** Pass null to remove the badge shown on the card. */
  badgeText?: string | null;
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

// ── Payment delegation (MANAGE_PRODUCTS) ─────────────────────────────────────

/**
 * A club association's payment-delegation state: whether it routes its online payments to a
 * parent association's Stripe Connect account and, if so, the lifecycle status and whether the
 * chosen parent can currently receive payments.
 */
export interface PaymentDelegationState {
  /** `pending` awaiting parent approval, `approved` when routing is live, `null` when not delegating. */
  status: 'pending' | 'approved' | null;
  parentAssociationId: string | null;
  /** Display name of the chosen parent, resolved server-side. */
  parentName: string | null;
  /** True when the parent has completed its own Stripe Connect onboarding (can receive payments). */
  parentReady: boolean;
}

/** A child association appearing in a parent's delegation queue (pending or approved). */
export interface DelegatedChild {
  associationId: string;
  name: string;
  slug: string;
  status: 'pending' | 'approved';
}

/** Returns this association's payment-delegation state (requires MANAGE_PRODUCTS). */
export async function getPaymentDelegation(associationId: string): Promise<PaymentDelegationState> {
  return request<PaymentDelegationState>(
    `/api/associations/${encodeURIComponent(associationId)}/payment-delegation`
  );
}

/**
 * Requests payment delegation from this association to `parentAssociationId`. The parent must
 * approve before routing goes live. Requires MANAGE_PRODUCTS.
 */
export async function requestPaymentDelegation(
  associationId: string,
  parentAssociationId: string
): Promise<PaymentDelegationState> {
  return request<PaymentDelegationState>(
    `/api/associations/${encodeURIComponent(associationId)}/payment-delegation`,
    { method: 'POST', body: JSON.stringify({ parentAssociationId }) }
  );
}

/** Cancels this association's own delegation link (pending or approved). Requires MANAGE_PRODUCTS. */
export async function cancelPaymentDelegation(
  associationId: string
): Promise<PaymentDelegationState> {
  return request<PaymentDelegationState>(
    `/api/associations/${encodeURIComponent(associationId)}/payment-delegation`,
    { method: 'DELETE' }
  );
}

/** Lists associations delegating (pending or approved) to this parent. Requires MANAGE_PRODUCTS. */
export async function listDelegatedChildren(associationId: string): Promise<DelegatedChild[]> {
  return request<DelegatedChild[]>(
    `/api/associations/${encodeURIComponent(associationId)}/payment-delegation/children`
  );
}

/** Approves a child's pending delegation request (`associationId` is the parent). Requires MANAGE_PRODUCTS. */
export async function approveDelegatedChild(
  associationId: string,
  childId: string
): Promise<{ associationId: string; status: 'approved' }> {
  return request<{ associationId: string; status: 'approved' }>(
    `/api/associations/${encodeURIComponent(associationId)}/payment-delegation/children/${encodeURIComponent(childId)}/approve`,
    { method: 'POST' }
  );
}

/**
 * Rejects a child's pending request or revokes an approved delegation (`associationId` is the
 * parent). Requires MANAGE_PRODUCTS.
 */
export async function rejectDelegatedChild(
  associationId: string,
  childId: string
): Promise<{ associationId: string; status: null }> {
  return request<{ associationId: string; status: null }>(
    `/api/associations/${encodeURIComponent(associationId)}/payment-delegation/children/${encodeURIComponent(childId)}/reject`,
    { method: 'POST' }
  );
}

/**
 * Lists a delegated child's completed purchases for the parent's accounting view (`associationId`
 * is the parent). Requires MANAGE_PRODUCTS and an approved delegation link.
 */
export async function listChildPurchases(
  associationId: string,
  childId: string
): Promise<AssociationPurchase[]> {
  return request<AssociationPurchase[]>(
    `/api/associations/${encodeURIComponent(associationId)}/payment-delegation/children/${encodeURIComponent(childId)}/purchases`
  );
}

/** Downloads a delegated child's purchases as .xlsx (`associationId` is the parent). Requires MANAGE_PRODUCTS. */
export async function exportChildPurchases(associationId: string, childId: string): Promise<void> {
  await downloadXlsxFromApi(
    `/api/associations/${encodeURIComponent(associationId)}/payment-delegation/children/${encodeURIComponent(childId)}/purchases/export`,
    'achats.xlsx'
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

/** Uploads a decorative icon for a product (e.g. a partner brand's logo). Requires MANAGE_PRODUCTS. */
export async function uploadProductIcon(
  associationId: string,
  productId: string,
  file: File
): Promise<AssociationProduct> {
  const base = socialUrl();
  const token = await getToken().catch(() => '');
  const fd = new FormData();
  fd.append('file', file);
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(
    `${base}/api/associations/${encodeURIComponent(associationId)}/products/${encodeURIComponent(productId)}/icon`,
    { method: 'POST', headers, body: fd }
  );
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`associations ${res.status}: ${details || res.statusText}`);
  }
  return (await res.json()) as AssociationProduct;
}

/** Removes a product's decorative icon (requires MANAGE_PRODUCTS). */
export async function deleteProductIcon(
  associationId: string,
  productId: string
): Promise<AssociationProduct> {
  return request<AssociationProduct>(
    `/api/associations/${encodeURIComponent(associationId)}/products/${encodeURIComponent(productId)}/icon`,
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

/**
 * A failed Cercle top-up delivery, as the admin dashboard needs it: the row plus who and what it
 * is about. The uuids alone said nothing about whose money is stuck.
 */
export interface WebhookDelivery {
  id: string;
  productId: string;
  productName: string | null;
  userId: string;
  /** Null when the account no longer exists - a different problem from a Cercle-side failure. */
  firstName: string | null;
  lastName: string | null;
  amountCents: number;
  paymentIntentId: string;
  status: 'pending' | 'delivered' | 'failed';
  /** Total sends, across the initial dispatch and every retry since. */
  attemptCount: number;
  autoRetryCount: number;
  lastAttemptAt: string | null;
  /** When the automatic retry will fire; null once the ladder is exhausted and a human is needed. */
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
}

/** Lists failed Cercle webhook deliveries (requires MANAGE_PRODUCTS). */
export async function listWebhookFailures(associationId: string): Promise<WebhookDelivery[]> {
  return request<WebhookDelivery[]>(
    `/api/associations/${encodeURIComponent(associationId)}/webhook-failures`
  );
}

/**
 * Retries a failed Cercle webhook delivery ONCE (requires MANAGE_PRODUCTS), and answers with the
 * row as it now stands - so the caller can say whether it went through rather than just reload.
 */
export async function retryWebhookDelivery(
  associationId: string,
  deliveryId: string
): Promise<WebhookDelivery> {
  return request<WebhookDelivery>(
    `/api/associations/${encodeURIComponent(associationId)}/webhook-failures/${encodeURIComponent(deliveryId)}/retry`,
    { method: 'POST' }
  );
}

/**
 * Drops a failed Cercle webhook delivery from the list (requires MANAGE_PRODUCTS). For a top-up
 * already settled by hand on the Cercle side, where retrying would credit it a second time.
 */
export async function deleteWebhookDelivery(
  associationId: string,
  deliveryId: string
): Promise<void> {
  await request<unknown>(
    `/api/associations/${encodeURIComponent(associationId)}/webhook-failures/${encodeURIComponent(deliveryId)}`,
    { method: 'DELETE' }
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
export type ConnectAccountStatus =
  | 'not_started'
  | 'onboarding_required'
  | 'pending'
  | 'active'
  | 'restricted'
  | 'unavailable';

/** Stripe Connect balance for a connected association account. */
export interface ConnectAccountBalance {
  availableCents: number;
  pendingCents: number;
  currency: string;
}

export interface ConnectAccountStatusResult {
  status: ConnectAccountStatus;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  detailsSubmitted?: boolean;
  currentlyDue?: string[];
  pendingVerification?: string[];
  disabledReason?: string | null;
  stripeAccountId?: string | null;
  dbOnboardingComplete?: boolean;
  balance?: ConnectAccountBalance | null;
  message?: string;
}

/** Formats a Connect balance amount for display. */
export function formatConnectAccountAmount(cents: number, currency: string): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

/** True when the association can accept online payments (live or DB flag). */
export function isConnectAccountReady(
  status: ConnectAccountStatusResult | null | undefined
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
export async function fetchConnectAccountStatus(
  associationId: string
): Promise<ConnectAccountStatusResult> {
  const base = coreUrl();
  const res = await apiFetch(
    `${base}/api/payments/connect-status/${encodeURIComponent(associationId)}`
  );
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`connect-status ${res.status}: ${details || res.statusText}`);
  }
  return (await res.json()) as ConnectAccountStatusResult;
}

/**
 * Opens the association's Stripe Connect dashboard (payouts, bank account).
 * Requires MANAGE_STRIPE_CONNECT.
 */
export async function openConnectAccountDashboard(associationId: string): Promise<string> {
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

/**
 * Unlinks the association's Stripe Connect account from Canari (MANAGE_STRIPE_CONNECT).
 * Local unlink only - the Stripe account itself is untouched and onboarding can be restarted.
 */
export async function disconnectConnectAccount(associationId: string): Promise<void> {
  const base = coreUrl();
  const res = await apiFetch(
    `${base}/api/payments/disconnect-connect-account/${encodeURIComponent(associationId)}`,
    { method: 'POST' }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { message?: string })?.message || `Stripe disconnect failed (${res.status})`
    );
  }
}

/**
 * Unlinks the association's Lydia Business from Canari (MANAGE_STRIPE_CONNECT).
 * Local unlink only - the Lydia Business itself is untouched and onboarding can be restarted.
 */
export async function disconnectLydiaConnect(associationId: string): Promise<void> {
  const base = coreUrl();
  const res = await apiFetch(
    `${base}/api/payments/disconnect-lydia-account/${encodeURIComponent(associationId)}`,
    { method: 'POST' }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { message?: string })?.message || `Lydia disconnect failed (${res.status})`
    );
  }
}

// ── Stripe onboarding ───────────────────────────────────────────────────────

export async function startConnectAccountOnboarding(
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

// ── Payment provider (WP-LYDIA-1) ───────────────────────────────────────────

export type PaymentProviderId = 'stripe' | 'lydia';

/** Which payment provider core-service is currently configured to use. */
export async function fetchActivePaymentProvider(): Promise<PaymentProviderId> {
  const base = coreUrl();
  const res = await apiFetch(`${base}/api/payments/provider`);
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`provider ${res.status}: ${details || res.statusText}`);
  }
  const data = (await res.json()) as { provider: PaymentProviderId };
  return data.provider;
}

/**
 * The association's legal profile, required upfront by Lydia's business/create - Lydia has no
 * hosted collection page like Stripe's accountLinks, so Canari collects it itself.
 */
export interface LydiaBusinessLegalProfile {
  name: string;
  address: string;
  zipcode: string;
  city: string;
  country: string;
  businessEmail: string;
  businessPhone: string;
}

/** Creates a Lydia Business for the association and returns its vendor token + Lydia console URL. */
export async function startLydiaOnboarding(
  associationId: string,
  legalProfile: LydiaBusinessLegalProfile
): Promise<{ url: string; accountId: string }> {
  const base = coreUrl();
  const res = await apiFetch(`${base}/api/payments/onboarding`, {
    method: 'POST',
    body: JSON.stringify({ associationId, legalProfile }),
  });
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`onboarding ${res.status}: ${details || res.statusText}`);
  }
  return (await res.json()) as { url: string; accountId: string };
}

// ── Association categories (thematic taxonomy) ───────────────────────────────

/** A managed thematic category used to group associations on the poster and directory. */
export interface AssociationCategory {
  id: string;
  /** Human-readable label (e.g. "Cuisine"). */
  label: string;
  /** URL-safe unique identifier (e.g. "cuisine"). */
  slug: string;
  /** Display position - lower values appear first. */
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAssociationCategoryPayload {
  label: string;
  slug: string;
  sortOrder?: number;
}

export interface UpdateAssociationCategoryPayload {
  label?: string;
  sortOrder?: number;
}

/** Lists categories in display order. Public. */
export async function listAssociationCategories(): Promise<AssociationCategory[]> {
  return request<AssociationCategory[]>('/api/associations/categories');
}

/** Creates a category. Global admins / BDE super-admins only. */
export async function createAssociationCategory(
  payload: CreateAssociationCategoryPayload
): Promise<AssociationCategory> {
  return request<AssociationCategory>('/api/associations/categories', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** Updates a category's label/order. Global admins / BDE super-admins only. */
export async function updateAssociationCategory(
  id: string,
  payload: UpdateAssociationCategoryPayload
): Promise<AssociationCategory> {
  return request<AssociationCategory>(`/api/associations/categories/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

/** Deletes a category and detaches it from its associations. Global admins / BDE super-admins only. */
export async function deleteAssociationCategory(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/associations/categories/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/** Persists a new top-to-bottom category order. Global admins / BDE super-admins only. */
export async function reorderAssociationCategories(
  orderedIds: string[]
): Promise<AssociationCategory[]> {
  return request<AssociationCategory[]>('/api/associations/categories/reorder', {
    method: 'PATCH',
    body: JSON.stringify({ orderedIds }),
  });
}

// ── Poster projects ("Carte de la Vie Asso") ─────────────────────────────────

/**
 * A saved, re-editable poster layout. `layout` holds only positions/sizes/doodles/theme/background;
 * live content (photos, members, colors) is re-resolved at render time so a regenerated map stays
 * current. Restricted to global admins / BDE super-admins.
 */
export interface PosterProject {
  id: string;
  name: string;
  /** Opaque JSON layout - the editor owns this shape. */
  layout: Record<string, unknown>;
  /** ISO timestamp of the last publish to the public showcase; null when this poster is offline. */
  publishedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePosterProjectPayload {
  name: string;
  layout?: Record<string, unknown>;
}

export interface UpdatePosterProjectPayload {
  name?: string;
  layout?: Record<string, unknown>;
}

/** Lists all poster projects, most-recently-updated first. Admins / BDE super-admins only. */
export async function listPosterProjects(): Promise<PosterProject[]> {
  return request<PosterProject[]>('/api/associations/poster');
}

/** Loads one poster project (full layout). Admins / BDE super-admins only. */
export async function getPosterProject(id: string): Promise<PosterProject> {
  return request<PosterProject>(`/api/associations/poster/${encodeURIComponent(id)}`);
}

/** Creates a poster project owned by the caller. Admins / BDE super-admins only. */
export async function createPosterProject(
  payload: CreatePosterProjectPayload
): Promise<PosterProject> {
  return request<PosterProject>('/api/associations/poster', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** Renames a project and/or replaces its layout. Admins / BDE super-admins only. */
export async function updatePosterProject(
  id: string,
  payload: UpdatePosterProjectPayload
): Promise<PosterProject> {
  return request<PosterProject>(`/api/associations/poster/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

/** Permanently deletes a project. Admins / BDE super-admins only. */
export async function deletePosterProject(id: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/associations/poster/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/**
 * Publishes a poster to the public showcase (portail-etu), replacing whatever was live - at most
 * one map is published at a time. The payload is the normalized geometry document built by
 * {@link buildPublishedCarte}, not the editor layout. Admins / BDE super-admins only.
 */
export async function publishPosterProject(
  id: string,
  payload: PublishedCarte
): Promise<PosterProject> {
  return request<PosterProject>(`/api/associations/poster/${encodeURIComponent(id)}/publish`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** Takes a poster offline; the showcase then renders no map. Admins / BDE super-admins only. */
export async function unpublishPosterProject(id: string): Promise<PosterProject> {
  return request<PosterProject>(`/api/associations/poster/${encodeURIComponent(id)}/unpublish`, {
    method: 'POST',
  });
}

// ── Partnerships ──────────────────────────────────────────────────────────

/** How a student obtains proof of eligibility for a partnership (mirrors the backend enum). */
export type PartnershipClaimMode = 'code_pool' | 'shared_code' | 'text';

export interface PartnershipCard {
  id: string;
  associationId: string;
  title: string;
  description: string | null;
  link: string | null;
  claimMode: PartnershipClaimMode;
  /** Populated only when `claimMode === 'shared_code'`. Never sent to students on the list endpoints. */
  sharedCode: string | null;
  /** Populated only when `claimMode === 'text'`. */
  staticText: string | null;
  /** Reserved to holders of the association's active cotisation tag. */
  membersOnly: boolean;
  isActive: boolean;
  /** Decorative icon shown on the card (e.g. the partner brand's logo); null = Handshake fallback. */
  iconUrl: string | null;
  /** Short decorative label shown as a pill on the card (e.g. "Nouveau", "Offre limitée"); null = no badge. */
  badgeText: string | null;
  /** True when the requesting user holds an active cotisation tag for this card's association. */
  viewerIsCotisant?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A partnership card as the manage view sees it: claim-pool stock alongside the card itself. */
export interface ManagedPartnershipCard extends PartnershipCard {
  claimedCount: number;
  totalCodes: number;
}

/** A claimed code as the admin claims view sees it, with the claimant's display name. */
export interface PartnershipClaimRow {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  code: string;
  claimedAt: string;
}

/** What a student receives on a successful claim - shape depends on `mode`. */
export interface PartnershipClaimResult {
  mode: PartnershipClaimMode;
  code?: string;
  staticText?: string;
}

export interface CreatePartnershipCardPayload {
  title: string;
  description?: string;
  link?: string;
  claimMode: PartnershipClaimMode;
  sharedCode?: string;
  staticText?: string;
  membersOnly?: boolean;
}

/** `claimMode` cannot be changed after creation - delete and recreate instead. */
export type UpdatePartnershipCardPayload = Partial<
  Omit<CreatePartnershipCardPayload, 'claimMode'>
> & {
  isActive?: boolean;
  /** Pass null to remove the badge shown on the card. */
  badgeText?: string | null;
};

/** Returns active partnership cards across every association (shown on the shop page). */
export async function listAllPartnerships(): Promise<PartnershipCard[]> {
  return request<PartnershipCard[]>('/api/associations/partnerships/all');
}

/** Returns active partnership cards for a single association (public). */
export async function listAssociationPartnerships(
  associationId: string
): Promise<PartnershipCard[]> {
  return request<PartnershipCard[]>(
    `/api/associations/${encodeURIComponent(associationId)}/partnerships`
  );
}

/** Returns all partnership cards including inactive ones, with claim-pool stock counts. Requires MANAGE_PARTNERSHIPS. */
export async function listAssociationPartnershipsForManage(
  associationId: string
): Promise<ManagedPartnershipCard[]> {
  return request<ManagedPartnershipCard[]>(
    `/api/associations/${encodeURIComponent(associationId)}/partnerships/manage`
  );
}

/** Creates a partnership card (requires MANAGE_PARTNERSHIPS). */
export async function createPartnershipCard(
  associationId: string,
  payload: CreatePartnershipCardPayload
): Promise<PartnershipCard> {
  return request<PartnershipCard>(
    `/api/associations/${encodeURIComponent(associationId)}/partnerships`,
    { method: 'POST', body: JSON.stringify(payload) }
  );
}

/** Updates a partnership card (requires MANAGE_PARTNERSHIPS). */
export async function updatePartnershipCard(
  associationId: string,
  cardId: string,
  payload: UpdatePartnershipCardPayload
): Promise<PartnershipCard> {
  return request<PartnershipCard>(
    `/api/associations/${encodeURIComponent(associationId)}/partnerships/${encodeURIComponent(cardId)}`,
    { method: 'PATCH', body: JSON.stringify(payload) }
  );
}

/** Deletes a partnership card (requires MANAGE_PARTNERSHIPS). */
export async function deletePartnershipCard(associationId: string, cardId: string): Promise<void> {
  await request<unknown>(
    `/api/associations/${encodeURIComponent(associationId)}/partnerships/${encodeURIComponent(cardId)}`,
    { method: 'DELETE' }
  );
}

/** Bulk-adds codes to a code_pool card's stock; already-stored codes are silently skipped. Requires MANAGE_PARTNERSHIPS. */
export async function addPartnershipCodes(
  associationId: string,
  cardId: string,
  codes: string[]
): Promise<{ added: number; totalCodes: number }> {
  return request<{ added: number; totalCodes: number }>(
    `/api/associations/${encodeURIComponent(associationId)}/partnerships/${encodeURIComponent(cardId)}/codes`,
    { method: 'POST', body: JSON.stringify({ codes }) }
  );
}

/** Lists claimed codes for a partnership card with claimant names (requires MANAGE_PARTNERSHIPS). */
export async function listPartnershipClaims(
  associationId: string,
  cardId: string
): Promise<PartnershipClaimRow[]> {
  return request<PartnershipClaimRow[]>(
    `/api/associations/${encodeURIComponent(associationId)}/partnerships/${encodeURIComponent(cardId)}/claims`
  );
}

/** Claims a partnership card (login required; `membersOnly` cards are gated server-side). */
export async function claimPartnership(
  associationId: string,
  cardId: string
): Promise<PartnershipClaimResult> {
  return request<PartnershipClaimResult>(
    `/api/associations/${encodeURIComponent(associationId)}/partnerships/${encodeURIComponent(cardId)}/claim`,
    { method: 'POST' }
  );
}

/** Uploads a decorative icon for a partnership card (e.g. the partner brand's logo). Requires MANAGE_PARTNERSHIPS. */
export async function uploadPartnershipIcon(
  associationId: string,
  cardId: string,
  file: File
): Promise<PartnershipCard> {
  const base = socialUrl();
  const token = await getToken().catch(() => '');
  const fd = new FormData();
  fd.append('file', file);
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(
    `${base}/api/associations/${encodeURIComponent(associationId)}/partnerships/${encodeURIComponent(cardId)}/icon`,
    { method: 'POST', headers, body: fd }
  );
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`associations ${res.status}: ${details || res.statusText}`);
  }
  return (await res.json()) as PartnershipCard;
}

/** Removes a partnership card's decorative icon (requires MANAGE_PARTNERSHIPS). */
export async function deletePartnershipIcon(
  associationId: string,
  cardId: string
): Promise<PartnershipCard> {
  return request<PartnershipCard>(
    `/api/associations/${encodeURIComponent(associationId)}/partnerships/${encodeURIComponent(cardId)}/icon`,
    { method: 'DELETE' }
  );
}
