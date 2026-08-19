import { currentUserId, fetchUserProfile, getSavedDisplayName } from '$lib/stores/user';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { m } from '$lib/paraglide/messages';

const displayNameCache = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();
const failedAt = new Map<string, number>();
const FAILURE_BACKOFF_MS = 2 * 60 * 1000;

/**
 * THE DENOMINATOR. A count of failures is not a rate, and only a rate can decide anything.
 *
 * The accusing `catch` below was added on 2026-08-16 because the symptom - nine of ten sidebar rows
 * reading "Utilisateur inconnu" for twenty seconds, twice, on both platforms - had reached a run log
 * with no line anywhere to explain it. It made the failures VISIBLE, and visible was still not
 * countable: one warn per lost name says nothing about whether that was one lookup in three or one
 * in three hundred, and those two answers argue for opposite things about `FAILURE_BACKOFF_MS`.
 *
 * A lookup that never reaches the network - a cache hit, the current user, the `system` sender, a
 * lookup already suppressed by the backoff - is NOT in the denominator. The question is how often a
 * fetch that was actually attempted came back a failure; folding cache hits in would drive the rate
 * towards zero exactly as the cache warmed, which is a measure of the cache rather than of the
 * fault.
 *
 * These live in the module rather than in a store because they are read at exactly one place: the
 * accusation itself. Nothing branches on them, so nothing can go wrong when they are wrong.
 */
let lookupsAttempted = 0;
let lookupsFailed = 0;

/**
 * What the counters say right now, as a sentence.
 *
 * Exported so a test can read it and a debug surface can print it without either one reaching into
 * module state - and so the one place that formats this is the same in both.
 */
export function displayNameLookupStats(): {
  attempted: number;
  failed: number;
  failureRate: number;
} {
  return {
    attempted: lookupsAttempted,
    failed: lookupsFailed,
    failureRate: lookupsAttempted === 0 ? 0 : lookupsFailed / lookupsAttempted,
  };
}

/**
 * A FAILURE RECORDED WHILE THE NETWORK WAS DOWN IS EVIDENCE ABOUT THE NETWORK, NOT ABOUT THE USER.
 *
 * `failedAt` answers "did this lookup fail", and `shouldSkipRetry` reads it as "will this lookup
 * fail" - two different questions, and regaining connectivity refutes the second one outright. Until
 * this listener existed, one blip anonymised every affected row for the FULL two minutes even though
 * the link was back within seconds: measured 2026-08-16, where a deliberate radio outage left the
 * phone logging `failed to lookup address information` for every profile fetch, and the sidebar then
 * read "Utilisateur inconnu" on 9 of 10 rows well after the radios returned.
 *
 * A SHORTER TIMER WOULD NOT HAVE BEEN THE FIX - it would only have made the same wrong answer
 * shorter. The backoff still earns its keep against a server that is genuinely refusing, which is the
 * case it was written for; what it may not do is outlive the condition it recorded.
 */
connectivity.onReconnect(() => {
  if (failedAt.size === 0) return;
  console.log(
    `[DISPLAYNAME] connectivity returned - retrying ${failedAt.size} suppressed lookup(s)`
  );
  failedAt.clear();
});

function normalizeUserId(userId: string): string {
  return userId.trim().toLowerCase();
}

function shouldSkipRetry(userId: string): boolean {
  const ts = failedAt.get(userId);
  return typeof ts === 'number' && Date.now() - ts < FAILURE_BACKOFF_MS;
}

/**
 * The sentinel senderId the chat gives its own system messages (`addMessageToChat('system', ...)`,
 * `isSystem: m.senderId === 'system'`). It is not a user id, so resolving it can only ever be a
 * request that 404s - `GET /api/users/system` was doing exactly that on every chat open.
 */
const SYSTEM_SENDER_ID = 'system';

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

  return m.user_unknown_label();
}

/**
 * Seeds the display-name cache with an already-known name (e.g. from a search result),
 * so subsequent sync reads show the name instantly instead of the raw user ID.
 */
export function seedUserDisplayName(userId: string, name: string): void {
  const trimmed = name.trim();
  if (trimmed) displayNameCache.set(normalizeUserId(userId), trimmed);
}

/**
 * Returns an already-known display name, or `null` when nothing is known yet.
 *
 * Unlike {@link getUserDisplayNameSync}, this never invents a placeholder. Callers that
 * persist the result - system message text is stored server-side and can never be
 * re-resolved - must be able to tell "not resolved yet" from a real name, otherwise they
 * bake the "unknown user" label into content that outlives the cache miss.
 */
export function peekUserDisplayName(userId: string): string | null {
  const normalized = normalizeUserId(userId);

  const cached = displayNameCache.get(normalized);
  if (cached) return cached;

  if (currentUserId()?.toLowerCase() === normalized) {
    const me = getSavedDisplayName()?.trim();
    if (me) {
      displayNameCache.set(normalized, me);
      return me;
    }
  }

  return null;
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

  // A FAILED LOOKUP MAY NOT OVERRULE A NAME THE CALLER ALREADY HAS. There used to be a branch here
  // returning the label during the backoff window, whose stated purpose - "don't flicker between the
  // raw ID and the label" - was already served by the line below, which never returns an id either.
  // What it actually did was DIFFERENT: it dropped the caller's `fallback`. So a conversation row
  // that knew perfectly well whose it was rendered as "Utilisateur inconnu" for two minutes because
  // one unrelated profile fetch had failed. Not knowing a name is not the same as knowing there is
  // none, and only the second may erase what the caller brought.
  return fallback?.trim() || m.user_unknown_label();
}

export async function resolveUserDisplayName(userId: string): Promise<string | null> {
  const normalized = normalizeUserId(userId);

  // Not a user: no name to resolve, and a fetch could only 404. Null, not the "unknown user"
  // label - a system message is rendered from its event, never from a sender name.
  if (normalized === SYSTEM_SENDER_ID) return null;

  const cached = displayNameCache.get(normalized);
  if (cached) return cached;
  if (shouldSkipRetry(normalized)) return null;

  if (inFlight.has(normalized)) {
    return inFlight.get(normalized)!;
  }

  // Counted HERE rather than at the top of the function: everything above this line returned
  // without asking the network, and a lookup that never left is not a lookup that could fail.
  lookupsAttempted += 1;

  const promise = fetchUserProfile(normalized)
    .then((profile) => {
      const value = formatProfileDisplayName(profile);
      // WHAT THIS CONDITION MEANT AND WHAT IT DOES ARE NOT THE SAME. It asks "is the result
      // different from the raw user id", which was written against this function's doc comment
      // ("firstName+lastName > displayName > id") - and the function returns the LABEL, never the
      // id. So the test is true for every profile that has ever been fetched, and the branch below
      // it has never run. Left as an explicit ANSWER rather than a repair: a profile that really
      // carries no name is a definitive result and caching the label for it is correct (the spec
      // pins exactly that). The dead `failedAt.set` is gone because a resolved fetch is not a
      // failure, whatever the profile turned out to contain.
      displayNameCache.set(normalized, value);
      failedAt.delete(normalized);
      return value;
    })
    .catch((e) => {
      // THE ONLY PLACE THAT KNOWS A NAME WAS LOST, AND IT USED TO SAY NOTHING. This file had no
      // logging at all, so a fallback that anonymises a conversation row could not be counted and
      // its rate against the population was unknown - which is how "9 of 10 rows read Utilisateur
      // inconnu" reached a run log with no matching line anywhere to explain it (2026-08-16, both
      // platforms). It ACCUSES because it is a fallback, not a path: one failure here hides this
      // user's name everywhere for FAILURE_BACKOFF_MS, without a single retry, and the previous
      // instance of this symptom survived for months because reloading hid it.
      lookupsFailed += 1;
      // The rate rides ON the accusation, so one line answers both "did a name get lost" and "how
      // often does that happen here" - the second is what decides whether a two-minute suppression
      // with no retry has a case, and it is unanswerable from a log of bare events.
      const stats = displayNameLookupStats();
      console.warn(
        `[DISPLAYNAME] profile fetch failed - this user renders as "unknown" for the next ${
          FAILURE_BACKOFF_MS / 1000
        }s with no retry (${stats.failed}/${stats.attempted} lookups failed this session, ${(
          stats.failureRate * 100
        ).toFixed(1)}%)`,
        { userId: normalized, error: e }
      );
      failedAt.set(normalized, Date.now());
      // NULL, NOT THE LABEL - "I could not find out" is what happened, and it is already what this
      // function returns for every other unresolved case (the system sender, the backoff window).
      // Returning the label instead made a failure indistinguishable from an answer, and all
      // twenty-six call sites are written as `if (resolved) use it`: every one of them therefore
      // OVERWROTE a name it already had with "Utilisateur inconnu" on the first failed fetch, and
      // then stopped doing so for the rest of the backoff - the same event rendering two different
      // ways depending on how recently it had happened. Rendering the label is the caller's
      // decision and `getUserDisplayNameSync` already makes it.
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
 *
 * Uses {@link peekUserDisplayName} rather than {@link getUserDisplayNameSync}: the latter
 * answers with the "unknown user" label on a cache miss, which is indistinguishable from a
 * real name and would short-circuit the fetch below for every user except the caller.
 */
export async function resolveDisplayNames(ids: string[]): Promise<(id: string) => string> {
  const map = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      const norm = normalizeUserId(id);
      const known = peekUserDisplayName(norm);
      if (known) {
        map.set(norm, known);
        return;
      }
      const resolved = await resolveUserDisplayName(norm);
      // `null` now also covers a fetch that FAILED, which used to arrive here as the label. Keeping
      // the id is the decision this function already made for the other unresolved cases, and its
      // reason holds for this one too: the text built here is STORED, so a label baked into it
      // outlives the outage that produced it, while an id can still be resolved by a later reader.
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

  const display = (p.displayName?.trim() || '?').charAt(0).toUpperCase();
  return display;
}
