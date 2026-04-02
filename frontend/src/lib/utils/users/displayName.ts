import { currentUserId, fetchUserProfile, getSavedDisplayName } from '$lib/stores/user';

const displayNameCache = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();
const failedAt = new Map<string, number>();
const FAILURE_BACKOFF_MS = 2 * 60 * 1000;

function normalizeUserId(userId: string): string {
  return userId.trim().toLowerCase();
}

function shouldSkipRetry(userId: string): boolean {
  const ts = failedAt.get(userId);
  return typeof ts === 'number' && Date.now() - ts < FAILURE_BACKOFF_MS;
}

export function getUserDisplayNameSync(userId: string, fallback?: string): string {
  const normalized = normalizeUserId(userId);
  const cached = displayNameCache.get(normalized);
  if (cached) return cached;

  if (currentUserId()?.toLowerCase() === normalized) {
    const me = getSavedDisplayName();
    if (me?.trim()) {
      const value = me.trim();
      displayNameCache.set(normalized, value);
      return value;
    }
  }

  return fallback?.trim() || userId;
}

export async function resolveUserDisplayName(userId: string): Promise<string | null> {
  const normalized = normalizeUserId(userId);

  const cached = displayNameCache.get(normalized);
  if (cached) return cached;
  if (shouldSkipRetry(normalized)) return null;

  if (inFlight.has(normalized)) {
    return inFlight.get(normalized)!;
  }

  const promise = fetchUserProfile(normalized)
    .then((profile) => {
      const value = profile.displayName?.trim();
      if (value) {
        displayNameCache.set(normalized, value);
        failedAt.delete(normalized);
        return value;
      }
      failedAt.set(normalized, Date.now());
      return null;
    })
    .catch(() => {
      failedAt.set(normalized, Date.now());
      return null;
    })
    .finally(() => {
      inFlight.delete(normalized);
    });

  inFlight.set(normalized, promise);
  return promise;
}
