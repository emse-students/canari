/**
 * WHETHER THIS DOCUMENT'S IN-MEMORY MLS STATE IS THE AUTHORITATIVE ONE - a fact of the LOAD, not of
 * the current leadership.
 *
 * Leadership says who MAY write; this says whose copy is current. They differ in exactly one window:
 * a follower PROMOTED IN PLACE (its leader closed) is the leader from that instant, but its copy is
 * the one it loaded as a follower, behind everything the old leader committed since. Its promotion
 * handler reloads it to read the state as it now stands (`useChatSession`), and until that reload
 * nothing it commits can be trusted: an external join built on that copy would leave a leaf on the
 * server whose private state exists nowhere. So a document commits, and serves the commits a
 * follower hands over (`tabCommitDelegation.ts`), only when it LOADED its state as the leader.
 *
 * Noted once per load, by the login, right after the election and before the state is read
 * ({@link noteMlsStateLoaded}). A promotion before that note is harmless - the state read after it is
 * the latest on disk; a promotion after it leaves the note at `follower`, which is the point.
 *
 * Kept apart from `tabLeader.ts` so that every module already mocking the election in its tests keeps
 * working: this reads the role through `getTabLeadership`, and adds only the load fact.
 */
import { getTabLeadership } from '$lib/mls-client/tabLeader';

let loadedAs: 'unknown' | 'leader' | 'follower' = 'unknown';

/** The login loaded (or is about to read) this document's MLS state with this role. */
export function noteMlsStateLoaded(asLeader: boolean): void {
  loadedAs = asLeader ? 'leader' : 'follower';
}

/**
 * Whether a commit must be refused here: a follower, or a leader whose copy was loaded as a follower
 * (promoted in place, reload pending). `undecided` with no load noted (a native shell before its
 * login, a unit test) is not refused - the same reading the follower gate always had.
 */
export function refusesCommitsHere(): boolean {
  return getTabLeadership() === 'follower' || loadedAs === 'follower';
}

/** Whether this document may run the commits a follower hands over: it leads, on a state it loaded as leader. */
export function servesFollowerCommits(): boolean {
  return getTabLeadership() === 'leader' && loadedAs === 'leader';
}

/**
 * Whether this document may ANSWER a follower's request without running it - a refusal, a leader
 * proven gone: it leads, and its copy is not a follower's. Before its login noted a load (`unknown`)
 * it may still say "locked" or "signed out"; a follower promoted in place says nothing at all.
 */
export function answersFollowerCommits(): boolean {
  return getTabLeadership() === 'leader' && loadedAs !== 'follower';
}

/** Test seam: back to the state of a document that has loaded nothing. */
export function resetStateAuthorityForTests(): void {
  loadedAs = 'unknown';
}
