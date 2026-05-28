import { apiFetch } from '$lib/utils/apiFetch';
import { socialUrl } from '$lib/utils/apiUrl';
import type { MediaRef } from '$lib/media';
import type { FormItem } from '$lib/forms/api';

export type PostImageRef = Omit<MediaRef, 'type'> & { caption?: string };

export interface PollOption {
  id: string;
  label: string;
  votes: string[];
}

export interface Poll {
  id: string;
  question: string;
  options: PollOption[];
  multipleChoice: boolean;
  endsAt?: string;
  votesByUser: Record<string, string[]>;
}

export interface PostForm {
  id: string;
  title: string;
  eventId: string;
  basePrice: number;
  currency: string;
  submitLabel: string;
  items: FormItem[];
}

export interface PostComment {
  id: string;
  userId: string;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  text: string;
  parentId?: string | null;
  likes: string[];
  createdAt: string;
  /** Encrypted media attached to this comment (GIF, screenshot, etc.). */
  media?: PostImageRef;
}

/** Display payload for posts published as an association (author identity hidden). */
export interface PostAssociationAuthor {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
}

/** Validated agenda event linked from a publication. */
export interface PostLinkedCalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  associationSlug: string;
}

export interface PostEntity {
  id: string;
  /** Omitted when the post is published as an association (`association` is set). */
  authorId?: string;
  authorDisplayName?: string | null;
  authorFirstName?: string | null;
  authorLastName?: string | null;
  markdown: string;
  mentions: string[];
  links: Array<{ url: string }>;
  images: PostImageRef[];
  polls: Poll[];
  forms?: PostForm[];
  attachedFormId?: string;
  associationId?: string;
  paymentAssociationId?: string;
  /** Present for association posts; use instead of author fields. */
  association?: PostAssociationAuthor;
  linkedCalendarEventId?: string | null;
  linkedCalendarEvent?: PostLinkedCalendarEvent | null;
  reactions?: Record<string, string>; // userId -> reactionType
  comments?: PostComment[];
  pinned?: boolean;
  scheduledAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PostFeed = 'all' | 'followed' | 'custom' | 'associations';

export interface ListPostsOptions {
  limit?: number;
  offset?: number;
  feed?: PostFeed;
  promo?: number;
  formation?: string;
}

export interface ScheduledPost {
  id: string;
  markdown: string;
  scheduledAt: string;
  createdAt: string;
}

export async function getMyScheduledPosts(): Promise<ScheduledPost[]> {
  return request<ScheduledPost[]>('/api/posts/my-scheduled');
}

export interface CreatePostPayload {
  markdown: string;
  scheduledAt?: string;
  images?: PostImageRef[];
  polls?: Array<{
    question: string;
    options: Array<{ label: string }>;
    multipleChoice?: boolean;
    endsAt?: string;
  }>;
  attachedFormId?: string;
  associationId?: string;
  linkedCalendarEventId?: string;
  paymentAssociationId?: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(`${socialUrl()}${path}`, init as any);

  if (!res.ok) {
    const details = await res.text();
    throw new Error(`post-service ${res.status}: ${details || res.statusText}`);
  }
  return (await res.json()) as T;
}

function buildListPostsSearchParams(options: ListPostsOptions): string {
  const p = new URLSearchParams();
  if (options.limit != null) p.set('limit', String(options.limit));
  if (options.offset != null) p.set('offset', String(options.offset));
  if (options.feed && options.feed !== 'all') p.set('feed', options.feed);
  if (options.promo != null && !Number.isNaN(options.promo)) p.set('promo', String(options.promo));
  if (options.formation?.trim()) p.set('formation', options.formation.trim());
  const s = p.toString();
  return s ? `?${s}` : '';
}

export async function searchPosts(
  q: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<PostEntity[]> {
  const p = new URLSearchParams({ q });
  if (opts.limit != null) p.set('limit', String(opts.limit));
  if (opts.offset != null) p.set('offset', String(opts.offset));
  return request<PostEntity[]>(`/api/posts/search?${p}`);
}

export async function getPost(postId: string): Promise<PostEntity> {
  return request<PostEntity>(`/api/posts/${postId}`);
}

export async function updatePost(postId: string, markdown: string): Promise<PostEntity> {
  return request<PostEntity>(`/api/posts/${postId}`, {
    method: 'PATCH',
    body: JSON.stringify({ markdown }),
  });
}

export async function deletePost(postId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/posts/${postId}`, { method: 'DELETE' });
}

/** @param limitOrOptions Pass a number for backward compatibility (`limit` only) or query options. */
export async function listPosts(
  limitOrOptions: number | ListPostsOptions = 30
): Promise<PostEntity[]> {
  const opts: ListPostsOptions =
    typeof limitOrOptions === 'number' ? { limit: limitOrOptions } : limitOrOptions;
  const q = buildListPostsSearchParams(opts);
  return request<PostEntity[]>(`/api/posts${q}`);
}

export async function createPost(payload: CreatePostPayload): Promise<PostEntity> {
  return request<PostEntity>('/api/posts', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function votePoll(
  postId: string,
  pollId: string,
  payload: { optionIds: string[] }
): Promise<PostEntity> {
  return request<PostEntity>(`/api/posts/${postId}/polls/${pollId}/vote`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function submitForm(
  postId: string,
  formId: string,
  payload: { selections: Record<string, string>; email?: string }
): Promise<{
  ok: boolean;
  requiresPayment: boolean;
  checkoutUrl?: string;
  message: string;
}> {
  return request(`/api/posts/${postId}/forms/${formId}/submit`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function addReaction(
  postId: string,
  reactionType: string
): Promise<{ ok: boolean; reactions: Record<string, string> }> {
  return request(`/api/posts/${postId}/reactions`, {
    method: 'POST',
    body: JSON.stringify({ reactionType }),
  });
}

export async function removeReaction(
  postId: string
): Promise<{ ok: boolean; reactions: Record<string, string> }> {
  return request(`/api/posts/${postId}/reactions`, { method: 'DELETE' });
}

export async function addComment(
  postId: string,
  payload: { text: string; parentId?: string; media?: PostImageRef }
): Promise<{ ok: boolean; comment: PostComment }> {
  return request(`/api/posts/${postId}/comments`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function likeComment(
  postId: string,
  commentId: string
): Promise<{ ok: boolean; comment: PostComment }> {
  return request(`/api/posts/${postId}/comments/${commentId}/like`, { method: 'POST' });
}

export async function editComment(
  postId: string,
  commentId: string,
  text: string
): Promise<{ ok: boolean; comment: PostComment }> {
  return request(`/api/posts/${postId}/comments/${commentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ text }),
  });
}

export async function deleteComment(postId: string, commentId: string): Promise<{ ok: boolean }> {
  return request(`/api/posts/${postId}/comments/${commentId}`, { method: 'DELETE' });
}

export interface ReportEntry {
  userId: string;
  reason: string;
  createdAt: string;
}

export interface ReportedPost {
  id: string;
  authorId?: string;
  markdown: string;
  createdAt: string;
  reports: ReportEntry[];
  pinned: boolean;
  associationId?: string;
}

export async function getReportedPosts(limit = 50, offset = 0): Promise<ReportedPost[]> {
  return request<ReportedPost[]>(`/api/posts/reported?limit=${limit}&offset=${offset}`);
}

export async function pinPost(postId: string): Promise<{ ok: boolean; pinned: boolean }> {
  return request(`/api/posts/${postId}/pin`, { method: 'PATCH' });
}

export async function unpinPost(postId: string): Promise<{ ok: boolean; pinned: boolean }> {
  return request(`/api/posts/${postId}/unpin`, { method: 'PATCH' });
}

export async function reportPost(
  postId: string,
  reason: string
): Promise<{ ok: boolean; alreadyReported?: boolean }> {
  return request(`/api/posts/${postId}/report`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

/** A post hidden by moderation, with its pending report count. Admin only. */
export interface HiddenPost {
  id: string;
  authorId: string | null;
  associationId: string | null;
  markdown: string;
  createdAt: string;
  pendingReportCount: number;
}

/** Returns all posts currently hidden by moderation. Global admin only. */
export async function listHiddenPosts(): Promise<HiddenPost[]> {
  return request<HiddenPost[]>('/api/posts/hidden');
}

/** Restores a moderation-hidden post back to the public feed. Global admin only. */
export async function unhidePost(postId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/posts/${postId}/unhide`, { method: 'PATCH' });
}

export interface PostNotification {
  id: string;
  type: string;
  postId: string;
  actorId: string;
  actorName: string;
  text: string;
  read: boolean;
  createdAt: string;
}

export async function getPostNotifications(limit = 30): Promise<PostNotification[]> {
  return request<PostNotification[]>(`/api/posts/notifications?limit=${limit}`);
}

export async function markPostNotificationsRead(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/posts/notifications/read-all', { method: 'POST' });
}

// ── User follows ──────────────────────────────────────────────────────────────

export async function followUser(userId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/posts/users/${encodeURIComponent(userId)}/follow`, {
    method: 'POST',
  });
}

export async function unfollowUser(userId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/posts/users/${encodeURIComponent(userId)}/follow`, {
    method: 'DELETE',
  });
}

export async function getUserFollowStatus(userId: string): Promise<{ following: boolean }> {
  return request<{ following: boolean }>(
    `/api/posts/users/${encodeURIComponent(userId)}/follow-status`
  );
}

// ── Form reminders ────────────────────────────────────────────────────────────

export async function subscribeFormReminder(formId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/forms/${encodeURIComponent(formId)}/remind`, {
    method: 'POST',
  });
}

export async function unsubscribeFormReminder(formId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/forms/${encodeURIComponent(formId)}/remind`, {
    method: 'DELETE',
  });
}

export async function checkFormReminder(formId: string): Promise<{ subscribed: boolean }> {
  return request<{ subscribed: boolean }>(`/api/forms/${encodeURIComponent(formId)}/remind`);
}
