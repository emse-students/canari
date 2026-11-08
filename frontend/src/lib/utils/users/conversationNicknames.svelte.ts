import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { currentUserId } from '$lib/stores/userState.svelte';
import { isBlockedWith } from '$lib/users/blocks';
import { normalizeNickname } from './nicknameRules';

/**
 * PER-CONVERSATION NICKNAMES ("Modifier les pseudos", owner 2026-10-14), as one dated register per
 * conversation: for each member, the nickname (or `null`, a reset), WHO set it and WHEN.
 *
 * TWO SOURCES, ONE REGISTER SHAPE (decided by the owner, 2026-10-14):
 *
 *  - a DM or a group (an MLS room): any member names any member, in a silent `nickname` MLS frame the
 *    server never reads. The register is merged last-write-wins per member, persisted per device like
 *    the pin register (`pinStore.svelte.ts`, the model), and RESTATED BY EVERY `history_bundle` - a
 *    member admitted later was not there when the frame went out, and the inviter's join push (sent
 *    even when every message is withheld) is what hands them the register. A diff that converges,
 *    never a timer and never a re-announcement.
 *  - a community: a moderator names a member, in a server column (social-service, migration 149) that
 *    re-checks the moderation grant. The register is kept in memory only, and fed by the server's
 *    list and by the `workspace.updated` event that carries each change to whoever is in the room -
 *    both MERGED by date, never replaced: a list cannot overrule a change made after it was asked
 *    for, and the server dates a clear like a set so a late event cannot resurrect it.
 *
 * A NICKNAME NEVER LEAVES ITS CONVERSATION: the register is keyed by the conversation's scope, so it
 * cannot reach the profile, another conversation, or a push (the push decision is in
 * docs/wiki/frontend/modules/chat.md, "Per-conversation nicknames").
 *
 * A nickname STAYS when its setter leaves (owner, 2026-10-18): nothing here is keyed by the setter.
 */

/**
 * One member's nickname state: `nickname` null is a reset, dated like a set. `reportSubject` is the
 * server's name for this exact version - a community's only (a report goes to the server, and an MLS
 * group's nicknames never reach it).
 */
export type NicknameEntry = {
  nickname: string | null;
  setBy: string;
  at: number;
  reportSubject?: string;
};

/** An entry with the member it names - the shape a bundle and the server carry. */
export type NicknameWireEntry = NicknameEntry & { userId: string };

const COMMUNITY_PREFIX = 'community:';
const storageKey = (scope: string) => `canari_nicknames_${scope}`;

/**
 * Entries kept per conversation, resets included, oldest evicted first - the pin register's bound and
 * its reason: a reset is never discharged, so without a cap a conversation grows this for ever.
 */
const MAX_ENTRIES = 500;

/** The scope of a community's register: one per community, shared by all its salons. */
export function communityNicknameScope(workspaceId: string): string {
  return `${COMMUNITY_PREFIX}${workspaceId}`;
}

/** Whether `scope` is a community's (server-held) rather than an MLS room's (device-held). */
export function isCommunityNicknameScope(scope: string): boolean {
  return scope.startsWith(COMMUNITY_PREFIX);
}

// PLAIN MAPS, AND ONE REVISION THAT CARRIES THE REACTIVITY. `load` runs lazily inside a `$derived`
// (the resolver, the screen): a reactive map created there would be a source OF that derived, which
// Svelte does not track - so a register first read inside a `$derived` never told it about a later
// change (the screen kept showing the old name, 2026-11-08) - and writing into a tracked container
// there throws `state_unsafe_mutation`. `revision` is created with the module, outside any reaction:
// every reader reads it, every write bumps it. A nickname changes rarely, so re-running every name
// reader on any change costs nothing measurable.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- intentional: see comment above
const registers = new Map<string, Map<string, NicknameEntry>>();
let revision = $state(0);

const norm = (id: string) => id.trim().toLowerCase();

/** Reads one raw entry into the register's shape, or null when it is malformed. */
function parseEntry(raw: unknown): NicknameEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { nickname?: unknown; setBy?: unknown; at?: unknown; reportSubject?: unknown };
  const setBy = typeof r.setBy === 'string' ? norm(r.setBy) : '';
  const at = Number(r.at);
  if (!setBy || !Number.isFinite(at) || at < 0) return null;
  const normalized = normalizeNickname(typeof r.nickname === 'string' ? r.nickname : null);
  if (!normalized.ok) return null;
  return {
    nickname: normalized.value,
    setBy,
    at,
    ...(typeof r.reportSubject === 'string' && r.reportSubject
      ? { reportSubject: r.reportSubject }
      : {}),
  };
}

function load(scope: string): Map<string, NicknameEntry> {
  const existing = registers.get(scope);
  if (existing) return existing;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- `revision` carries the reactivity
  const map = new Map<string, NicknameEntry>();
  if (!isCommunityNicknameScope(scope)) {
    try {
      const raw = localStorage.getItem(storageKey(scope));
      if (raw) {
        for (const [userId, value] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
          const entry = parseEntry(value);
          if (userId && entry) map.set(norm(userId), entry);
        }
      }
    } catch (e) {
      // The register is restated by the next bundle, so an unreadable copy costs a wait, not the
      // names - but it is said, because nothing else would.
      console.warn(`[NICKNAME] stored register unreadable for ${scope.slice(0, 8)}…: ${String(e)}`);
    }
  }
  registers.set(scope, map);
  return map;
}

function persist(scope: string, map: Map<string, NicknameEntry>): void {
  revision++;
  if (map.size > MAX_ENTRIES) {
    const doomed = [...map.entries()]
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, map.size - MAX_ENTRIES);
    for (const [id] of doomed) map.delete(id);
  }
  // A community's register is the server's: nothing of it is written to the device.
  if (isCommunityNicknameScope(scope)) return;
  try {
    localStorage.setItem(storageKey(scope), JSON.stringify(Object.fromEntries(map)));
  } catch (e) {
    console.warn(`[NICKNAME] register not persisted for ${scope.slice(0, 8)}…: ${String(e)}`);
  }
}

/**
 * Does `next` supersede `held`? Strictly later wins. A TIE needs a rule two devices share whatever
 * order they saw the pair in: a reset wins (the state the target can always restore), then the
 * larger `setBy` + nickname, which is arbitrary but the same everywhere.
 */
export function nicknameSupersedes(next: NicknameEntry, held: NicknameEntry | undefined): boolean {
  if (!held) return true;
  if (next.at !== held.at) return next.at > held.at;
  if ((next.nickname === null) !== (held.nickname === null)) return next.nickname === null;
  return `${next.setBy}\u0000${next.nickname ?? ''}` > `${held.setBy}\u0000${held.nickname ?? ''}`;
}

/**
 * Applies one dated statement about `userId`'s nickname, and says whether it was the newest.
 * `false` is the ordinary outcome of replaying a log already followed, or of a malformed value.
 */
export function applyNickname(scope: string, userId: string, entry: NicknameEntry): boolean {
  const target = norm(userId);
  const parsed = parseEntry(entry);
  if (!scope || !target || !parsed) {
    console.warn(
      `[NICKNAME] refused a malformed nickname for ${target.slice(0, 8) || 'nobody'} in ${scope.slice(0, 8)}…`
    );
    return false;
  }
  const map = load(scope);
  if (!nicknameSupersedes(parsed, map.get(target))) return false;
  map.set(target, parsed);
  persist(scope, map);
  return true;
}

/** The whole register, resets included - what a `history_bundle` restates so peers can merge it. */
export function nicknameEntries(scope: string): NicknameWireEntry[] {
  void revision;
  return [...load(scope)].map(([userId, e]) => ({ userId, ...e }));
}

/**
 * Merges a peer's register into ours, entry by entry, the newer winning. Returns how many entries
 * changed, so a caller reports a convergence and stays silent on a bundle that restated nothing new.
 */
export function mergeNicknameEntries(scope: string, incoming: unknown): number {
  if (!scope || !Array.isArray(incoming) || incoming.length === 0) return 0;
  const map = load(scope);
  let changed = 0;
  for (const raw of incoming) {
    const userId =
      raw && typeof raw === 'object' && typeof (raw as { userId?: unknown }).userId === 'string'
        ? norm((raw as { userId: string }).userId)
        : '';
    const entry = parseEntry(raw);
    if (!userId || !entry) continue;
    if (!nicknameSupersedes(entry, map.get(userId))) continue;
    map.set(userId, entry);
    changed++;
  }
  if (changed > 0) persist(scope, map);
  return changed;
}

/** The raw entry for `userId` in `scope`, or null (reactive). The screen reads it for "set by X". */
export function nicknameEntry(
  scope: string | null | undefined,
  userId: string
): NicknameEntry | null {
  if (!scope || !userId) return null;
  void revision;
  return load(scope).get(norm(userId)) ?? null;
}

// ── A blocked person cannot rename the blocker ─────────────────────────────────────────────────
//
// A community refuses it at the server. An MLS group cannot: the server never reads the frame, and a
// block is PRIVATE, so no third member can know one stands between the setter and the target. The
// two parties who can are the setter (whose screen asks `block-status` before sending) and the
// TARGET, whose own devices check the setter of a nickname naming them before ever showing it. Until
// that answer arrives - or when it cannot be had - the target sees their own name: their own label is
// the one place an unchecked insult may not land.

// Keyed by VIEWER and setter: a verdict is about a pair, and an account switch must not inherit one.
const setterVerdicts = new SvelteMap<string, 'clear' | 'blocked'>();
const setterAsks = new SvelteSet<string>();
const pairKey = (viewer: string, setBy: string) => `${viewer}|${setBy}`;

function askAboutSetter(viewer: string, setBy: string): void {
  const key = pairKey(viewer, setBy);
  if (setterAsks.has(key)) return;
  setterAsks.add(key);
  void isBlockedWith(setBy).then(
    (blocked) => {
      setterVerdicts.set(key, blocked ? 'blocked' : 'clear');
      if (blocked) {
        console.info(
          `[NICKNAME] a nickname naming this account was set by ${setBy.slice(0, 8)}, with whom a block stands - not shown`
        );
      }
    },
    (e: unknown) => {
      // Not an answer: the next read asks again.
      setterAsks.delete(key);
      console.warn(
        `[NICKNAME] could not ask whether a block stands with ${setBy.slice(0, 8)} - this account's own name is shown until it can: ${String(e)}`
      );
    }
  );
}

/**
 * The nickname to SHOW for `userId` in `scope`, or null for none - the one reader the name resolver
 * (`displayName.ts`) consults. A nickname of the viewer set by somebody else is shown only once that
 * person is known not to stand in a block with the viewer (see above).
 */
export function visibleNickname(scope: string | null | undefined, userId: string): string | null {
  const entry = nicknameEntry(scope, userId);
  if (!entry?.nickname) return null;
  const me = currentUserId();
  if (!me || norm(me) !== norm(userId) || entry.setBy === norm(me)) return entry.nickname;
  const viewer = norm(me);
  const verdict = setterVerdicts.get(pairKey(viewer, entry.setBy));
  if (verdict === 'clear') return entry.nickname;
  // The ask is a side effect of a READ, scheduled and written asynchronously, so it never mutates
  // state inside the reactive read that triggered it.
  if (verdict === undefined) queueMicrotask(() => askAboutSetter(viewer, entry.setBy));
  return null;
}

/** Test seam: forgets every register and verdict, as a fresh page would. */
export function resetConversationNicknamesForTests(): void {
  registers.clear();
  revision++;
  setterVerdicts.clear();
  setterAsks.clear();
}
