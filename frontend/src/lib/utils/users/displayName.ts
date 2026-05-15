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

/**
 * Format a user display name with priority: firstName+lastName > displayName > id
 * Returns the parts joined with a space.
 */
function formatProfileDisplayName(profile: {
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  id: string;
}): string {
  const first = profile.firstName?.trim();
  const last = profile.lastName?.trim();

  if (first && last) {
    return `${first} ${last}`;
  }
  if (first) {
    return first;
  }
  if (last) {
    return last;
  }

  const display = profile.displayName?.trim();
  if (display) {
    return display;
  }

  return profile.id;
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
      const value = formatProfileDisplayName(profile);
      if (value !== normalized) {
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

/**
 * Resolves display names for multiple IDs concurrently.
 * Returns a getter function (id) => name for building system message text.
 */
export async function resolveDisplayNames(ids: string[]): Promise<(id: string) => string> {
  const map = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      const norm = normalizeUserId(id);
      const sync = getUserDisplayNameSync(norm);
      if (sync !== norm) {
        map.set(norm, sync);
        return;
      }
      const resolved = await resolveUserDisplayName(norm);
      map.set(norm, resolved ?? id);
    })
  );
  return (id: string) => map.get(normalizeUserId(id)) ?? id;
}

/**
 * Get user initials for avatar placeholder.
 * Priority: (firstName initial + lastName initial) > firstName initial > lastName initial > first letter of displayName/id
 */
export function getUserInitials(
  userId: string,
  profile?: {
    firstName?: string | null;
    lastName?: string | null;
    displayName?: string | null;
    id?: string;
  }
): string {
  const p = profile || { id: userId };
  const first = p.firstName?.trim().charAt(0)?.toUpperCase() || '';
  const last = p.lastName?.trim().charAt(0)?.toUpperCase() || '';

  if (first && last) {
    return first + last;
  }
  if (first) {
    return first;
  }
  if (last) {
    return last;
  }

  const display = (p.displayName?.trim() || p.id || userId).charAt(0).toUpperCase();
  return display;
}
