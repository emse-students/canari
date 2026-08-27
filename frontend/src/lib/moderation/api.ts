import { apiFetch } from '$lib/utils/apiFetch';
import { socialUrl } from '$lib/utils/apiUrl';

/**
 * A refusal from the moderation API, carrying the machine-readable discriminator the server sent.
 *
 * IT EXISTS SO NOBODY READS THE MESSAGE AGAIN. Telling "you already reported this" from a real
 * failure was done with `message.includes('already')` until 2026-08-27 - a distinction carried in
 * prose, which the server was free to reword at any time. The server now answers 409 with
 * `code: 'ALREADY_REPORTED'`, and that is what call sites branch on.
 */
export class ModerationApiError extends Error {
  constructor(
    readonly status: number,
    /** The server's `code` field when it sent one, e.g. `ALREADY_REPORTED`. Null otherwise. */
    readonly code: string | null,
    message: string
  ) {
    super(message);
    this.name = 'ModerationApiError';
  }

  /** True when this refusal is the server saying the caller has already reported this content. */
  get isAlreadyReported(): boolean {
    return this.code === 'ALREADY_REPORTED';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(`${socialUrl()}${path}`, init as any);
  if (!res.ok) {
    const details = await res.text().catch(() => '');
    let code: string | null = null;
    try {
      code = (JSON.parse(details) as { code?: string }).code ?? null;
    } catch {
      // Not a JSON body - nginx and the framework both answer in plain text on some paths. The
      // status still classifies, so this is a missing discriminator, not a failure to report.
      code = null;
    }
    throw new ModerationApiError(
      res.status,
      code,
      `moderation ${res.status}: ${details || res.statusText}`
    );
  }
  return (await res.json()) as T;
}

/** A content report filed by a user. */
export interface ContentReport {
  id: string;
  reporterId: string;
  /** `user` reports a person; `contentId` is then the reported account's id. */
  contentType: 'post' | 'comment' | 'user';
  contentId: string;
  reason: string;
  details: string | null;
  status: 'pending' | 'reviewed' | 'dismissed';
  reviewedBy: string | null;
  /** User ID of the reported content's author. Null for association posts. */
  reportedUserId: string | null;
  createdAt: string;
  /** Short excerpt of the reported content (first ~250 chars), or the display name when a person is reported. Null for deleted content. */
  contentPreview: string | null;
  /** For comment reports: ID of the parent post, used for navigation. Null otherwise. */
  postId: string | null;
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

/**
 * Submits a content report for a post, a comment, or a person.
 *
 * Throws {@link ModerationApiError}; `isAlreadyReported` tells a duplicate from a real failure.
 */
export async function createReport(
  contentType: 'post' | 'comment' | 'user',
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

/** Mute status returned to the restricted user (banner in the app). */
export interface UserMuteStatus {
  isMuted: boolean;
  mutedReason: string | null;
  mutedAt: string | null;
}

/** Returns whether the authenticated user is currently muted and the visible reason. */
export async function getMyMuteStatus(): Promise<UserMuteStatus> {
  return request<UserMuteStatus>('/api/moderation/me/mute-status');
}

/** Deletes a reported comment by id (moderator). */
export async function deleteReportedComment(commentId: string): Promise<{ postId: string }> {
  return request<{ postId: string }>(`/api/moderation/comments/${commentId}/delete`, {
    method: 'POST',
  });
}
