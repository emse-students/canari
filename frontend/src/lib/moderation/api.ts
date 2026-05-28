import { apiFetch } from '$lib/utils/apiFetch';
import { socialUrl } from '$lib/utils/apiUrl';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(`${socialUrl()}${path}`, init as any);
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    throw new Error(`moderation ${res.status}: ${details || res.statusText}`);
  }
  return (await res.json()) as T;
}

/** A content report filed by a user. */
export interface ContentReport {
  id: string;
  reporterId: string;
  contentType: 'post' | 'comment' | 'message';
  contentId: string;
  reason: string;
  details: string | null;
  status: 'pending' | 'reviewed' | 'dismissed';
  reviewedBy: string | null;
  /** User ID of the reported content's author. Null for association posts or messages. */
  reportedUserId: string | null;
  createdAt: string;
}

/** A muted user record. */
export interface MutedUser {
  id: string;
  userId: string;
  isMuted: boolean;
  mutedBy: string | null;
  mutedAt: string | null;
  mutedReason: string | null;
}

/** Submits a content report for a post, comment, or message. */
export async function createReport(
  contentType: 'post' | 'comment' | 'message',
  contentId: string,
  reason: 'spam' | 'harassment' | 'inappropriate' | 'other',
  details?: string,
  reportedUserId?: string | null
): Promise<ContentReport> {
  return request<ContentReport>('/api/moderation/reports', {
    method: 'POST',
    body: JSON.stringify({ contentType, contentId, reason, details, reportedUserId }),
  });
}

/** Returns all content reports. Requires MODERATE flag or global admin. */
export async function listReports(): Promise<ContentReport[]> {
  return request<ContentReport[]>('/api/moderation/reports');
}

/**
 * Marks a content report as reviewed or dismissed.
 * Requires MODERATE flag or global admin.
 */
export async function reviewReport(
  reportId: string,
  action: 'reviewed' | 'dismissed'
): Promise<ContentReport> {
  return request<ContentReport>(`/api/moderation/reports/${reportId}`, {
    method: 'PATCH',
    body: JSON.stringify({ action }),
  });
}

/** Mutes a user. Requires MODERATE flag or global admin. */
export async function muteUser(userId: string, reason?: string): Promise<MutedUser> {
  return request<MutedUser>(`/api/moderation/${userId}/mute`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

/** Unmutes a user. Requires MODERATE flag or global admin. */
export async function unmuteUser(userId: string): Promise<MutedUser> {
  return request<MutedUser>(`/api/moderation/${userId}/unmute`, { method: 'POST' });
}

/** Returns all currently muted users. Requires MODERATE flag or global admin. */
export async function listMutedUsers(): Promise<MutedUser[]> {
  return request<MutedUser[]>('/api/moderation/muted');
}

/** Returns whether the authenticated user is currently muted. */
export async function getMyMuteStatus(): Promise<{ isMuted: boolean }> {
  return request<{ isMuted: boolean }>('/api/moderation/me/mute-status');
}
