import { SvelteMap } from 'svelte/reactivity';
import { currentUserId } from '$lib/stores/userState.svelte';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { isBlockedWith } from '$lib/users/blocks';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { normalizeNickname } from './nicknameRules';
import {
  forgetNicknameMirror,
  noteMirroredNickname,
  noteMirroredSalon,
  noteMirroredScopeRestated,
  noteMirrorSessionStart,
} from './nicknameMirror';

/**
 * PER-CONVERSATION NICKNAMES ("Modifier les pseudos", owner 2026-10-14), as one dated register per
 * conversation: for each member, the nickname (or `null`, a reset), WHO set it and WHEN.
 *
 * TWO SOURCES, ONE REGISTER SHAPE (decided by the owner, 2026-10-14):
 *
 *  - a DM or a group (an MLS room): any member names any member, in a silent `nickname` MLS frame the
 *    server never reads. Merged per member, persisted per device AND PER ACCOUNT. A member admitted
 *    later gets the register from the inviter's addressed JOIN PUSH only - see "Who is believed".
 *  - a community: a moderator names a member, in a server column (social-service, migration 149) that
 *    re-checks the moderation grant. Kept in memory only, fed by the server's list and by the
 *    `workspace.updated` event (see `nicknameActions.ts`).
 *
 * WHO IS BELIEVED (review of #3177). An MLS frame names its setter through the identity MLS
 * authenticated, and the server answers for a community's: those entries are VERIFIED. A bundle's
 * entries are a relayer's word about what somebody else did, so they are UNVERIFIED: taken only from
 * the join push addressed to this device, only about current members, and any verified statement
 * supersedes one whatever its date. An unverified entry that names the viewer as its own setter
 * cannot skip the block check (`visibleNickname`). Every source names a CURRENT MEMBER as its
 * target, and the register has a hard cap (`MAX_NICKNAME_ENTRIES`), so nothing grows it without bound.
 *
 * A NICKNAME NEVER LEAVES ITS CONVERSATION: the register is keyed by the conversation's scope, so it
 * cannot reach the profile or another conversation. It DOES name its member in that conversation's
 * NOTIFICATIONS (owner, 2026-11-14, reversing 2026-11-08: "comme sur Messenger, tous les pseudos"),
 * composed by the device: every change is mirrored for the native push path (`nicknameMirror.ts`,
 * {@link mirroredNickname}), and no server ever puts one in a push (docs/wiki/frontend/modules/
 * chat.md, "Per-conversation nicknames"). A nickname STAYS when its setter leaves: nothing is keyed
 * by them.
 */

/**
 * One member's nickname state: `nickname` null is a reset, dated like a set. `verified` says the
 * setter was authenticated (an MLS frame, the server); a bundle's entries are not. `reportSubject` is
 * the server's name for this exact version - a community's only.
 */
export type NicknameEntry = {
  nickname: string | null;
  setBy: string;
  at: number;
  verified?: boolean;
  reportSubject?: string;
};

/** An entry with the member it names - the shape a bundle and the server carry. */
export type NicknameWireEntry = NicknameEntry & { userId: string };

/**
 * How far a sender's `at` may run ahead of the server's time for its frame. The frame is dated by its
 * sender (so the local apply and the broadcast agree), but an unbounded date would let one frame dated
 * next year freeze a nickname against every later change.
 */
export const NICKNAME_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** `at`, no later than `serverAt` + {@link NICKNAME_CLOCK_SKEW_MS} when a server time is known. */
export function boundedNicknameAt(at: number, serverAt: number | undefined): number {
  if (!(typeof serverAt === 'number' && serverAt > 0)) return at;
  return Math.min(at, serverAt + NICKNAME_CLOCK_SKEW_MS);
}

const COMMUNITY_PREFIX = 'community:';

/**
 * Entries kept per conversation, a HARD cap whatever their kind (review of #3177): every source is
 * held to naming a current member, and this bounds what a stream of them can still grow. When over
 * it, entries are evicted in this order - a member no longer in the conversation (when the caller
 * knows the roster), then an unverified entry, then the oldest - so a relayer's word goes before a
 * member's authenticated statement does.
 */
export const MAX_NICKNAME_ENTRIES = 500;

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
// Keyed by ACCOUNT and scope: two accounts on one install never read each other's register.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- intentional: see comment above
const registers = new Map<string, Map<string, NicknameEntry>>();
let revision = $state(0);

const norm = (id: string) => id.trim().toLowerCase();
const account = () => norm(currentUserId() ?? '');

/** Reads one raw entry into the register's shape, or null when it is malformed. */
function parseEntry(raw: unknown): NicknameEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as {
    nickname?: unknown;
    setBy?: unknown;
    at?: unknown;
    verified?: unknown;
    reportSubject?: unknown;
  };
  const setBy = typeof r.setBy === 'string' ? norm(r.setBy) : '';
  const at = Number(r.at);
  if (!setBy || !Number.isFinite(at) || at < 0) return null;
  const normalized = normalizeNickname(typeof r.nickname === 'string' ? r.nickname : null);
  if (!normalized.ok) return null;
  return {
    nickname: normalized.value,
    setBy,
    at,
    verified: r.verified === true,
    ...(typeof r.reportSubject === 'string' && r.reportSubject
      ? { reportSubject: r.reportSubject }
      : {}),
  };
}

function load(scope: string): Map<string, NicknameEntry> {
  const owner = account();
  const key = `${owner}|${scope}`;
  const existing = registers.get(key);
  if (existing) return existing;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- `revision` carries the reactivity
  const map = new Map<string, NicknameEntry>();
  if (!isCommunityNicknameScope(scope) && owner) {
    try {
      const raw = localStorage.getItem(ACCOUNT_KEY.conversationNicknames(owner, scope));
      if (raw) {
        for (const [userId, value] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
          const entry = parseEntry(value);
          if (userId && entry) map.set(norm(userId), entry);
        }
      }
    } catch (e) {
      // An unreadable copy costs the names until the next frame - and it is said, because nothing
      // else would.
      console.warn(`[NICKNAME] stored register unreadable for ${scope.slice(0, 8)}…: ${String(e)}`);
    }
  }
  registers.set(key, map);
  return map;
}

function persist(
  scope: string,
  map: Map<string, NicknameEntry>,
  members?: ReadonlySet<string> | null
): void {
  revision++;
  if (map.size > MAX_NICKNAME_ENTRIES) {
    const rank = ([id, e]: [string, NicknameEntry]) => [
      members && !members.has(id) ? 0 : 1,
      e.verified ? 1 : 0,
      e.at,
    ];
    const doomed = [...map.entries()]
      .sort((a, b) => {
        const [x, y] = [rank(a), rank(b)];
        return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
      })
      .slice(0, map.size - MAX_NICKNAME_ENTRIES);
    for (const [id] of doomed) {
      map.delete(id);
      noteMirroredNickname(scope, id, null);
    }
    console.warn(
      `[NICKNAME] register of ${scope.slice(0, 8)}… over ${MAX_NICKNAME_ENTRIES} entries - ${doomed.length} evicted`
    );
  }
  // A community's register is the server's: nothing of it is written to the device.
  const owner = account();
  if (isCommunityNicknameScope(scope) || !owner) return;
  try {
    localStorage.setItem(
      ACCOUNT_KEY.conversationNicknames(owner, scope),
      JSON.stringify(Object.fromEntries(map))
    );
  } catch (e) {
    console.warn(`[NICKNAME] register not persisted for ${scope.slice(0, 8)}…: ${String(e)}`);
  }
}

/**
 * Does `next` supersede `held`? A VERIFIED statement beats an unverified one whatever the dates, and
 * an unverified one never replaces a verified one. Between two of a kind, strictly later wins; a TIE
 * needs a rule two devices share whatever order they saw the pair in: a reset wins (the state the
 * target can always restore), then the larger `setBy` + nickname, arbitrary but the same everywhere.
 */
export function nicknameSupersedes(next: NicknameEntry, held: NicknameEntry | undefined): boolean {
  if (!held) return true;
  if (!!next.verified !== !!held.verified) return !!next.verified;
  if (next.at !== held.at) return next.at > held.at;
  if ((next.nickname === null) !== (held.nickname === null)) return next.nickname === null;
  return `${next.setBy}\u0000${next.nickname ?? ''}` > `${held.setBy}\u0000${held.nickname ?? ''}`;
}

/**
 * Applies one AUTHENTICATED statement about `userId`'s nickname - an MLS frame, the viewer's own
 * change, or the server's answer - and says whether it was the newest. `false` is the ordinary outcome
 * of replaying a log already followed, or of a malformed value. `members`, when the caller read the
 * roster, ranks the eviction a full register needs.
 */
export function applyNickname(
  scope: string,
  userId: string,
  entry: NicknameEntry,
  members?: ReadonlySet<string> | null
): boolean {
  const target = norm(userId);
  const parsed = parseEntry({ ...entry, verified: true });
  if (!scope || !target || !parsed) {
    console.warn(
      `[NICKNAME] refused a malformed nickname for ${target.slice(0, 8) || 'nobody'} in ${scope.slice(0, 8)}…`
    );
    return false;
  }
  const map = load(scope);
  if (!nicknameSupersedes(parsed, map.get(target))) return false;
  map.set(target, parsed);
  persist(scope, map, members);
  mirrorEntry(scope, target);
  return true;
}

/**
 * Forgets `userId`'s entry in `scope` - a community's list that no longer names them (a member who
 * left, a membership created afresh). Never used on an MLS room, whose register only merges.
 */
export function dropNickname(scope: string, userId: string): boolean {
  const map = load(scope);
  if (!map.delete(norm(userId))) return false;
  persist(scope, map);
  noteMirroredNickname(scope, norm(userId), null);
  return true;
}

/** The whole register, resets included - what the inviter's join push restates for a new member. */
export function nicknameEntries(scope: string): NicknameWireEntry[] {
  void revision;
  return [...load(scope)].map(([userId, e]) => ({ userId, ...e }));
}

/**
 * Merges the register a JOIN PUSH addressed to this device restates - the one bundle a new member's
 * names may come from (`systemMessageHandler`). Every entry is UNVERIFIED, must name a current
 * member as its TARGET (its setter may have left since: a nickname stays when its setter leaves,
 * owner 2026-10-18), is dated no later than the bundle's server time allows, and there are at most
 * as many as there are members. Returns how many entries changed.
 */
export function mergeBundleNicknames(
  scope: string,
  incoming: unknown,
  opts: { members: ReadonlySet<string>; serverAt: number | undefined }
): number {
  if (!scope || !Array.isArray(incoming) || incoming.length === 0) return 0;
  const map = load(scope);
  let changed = 0;
  let taken = 0;
  const mirrored: string[] = [];
  for (const raw of incoming) {
    if (taken >= opts.members.size) break;
    const userId =
      raw && typeof raw === 'object' && typeof (raw as { userId?: unknown }).userId === 'string'
        ? norm((raw as { userId: string }).userId)
        : '';
    const entry = parseEntry({ ...(raw as object), verified: false });
    if (!userId || !entry || !opts.members.has(userId)) continue;
    taken++;
    entry.at = boundedNicknameAt(entry.at, opts.serverAt);
    if (!nicknameSupersedes(entry, map.get(userId))) continue;
    map.set(userId, entry);
    changed++;
    mirrored.push(userId);
  }
  if (changed > 0) persist(scope, map, opts.members);
  for (const userId of mirrored) mirrorEntry(scope, userId);
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

/**
 * Forgets every register of `userId` on this install - its stored copies and what is in memory. Run
 * at sign-out (`clearUserLocally`) and by the account deletion's sweep (`ACCOUNT_KEY`): the names
 * other members set are text written about people, and outlive neither.
 */
export function forgetConversationNicknames(userId: string): void {
  const owner = norm(userId);
  if (!owner) return;
  const prefix = ACCOUNT_KEY.conversationNicknames(owner, '');
  const doomed: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch (e) {
    console.warn(`[NICKNAME] stored registers of ${owner.slice(0, 8)} not removed: ${String(e)}`);
  }
  // Deleting the entry being visited is defined for a Map's iterator: no copy is needed.
  for (const key of registers.keys()) if (key.startsWith(`${owner}|`)) registers.delete(key);
  for (const key of setterVerdicts.keys()) {
    if (key.startsWith(`${owner}|`)) setterVerdicts.delete(key);
  }
  // And the native copy the notifications read: it outlives the account no more than this does.
  void forgetNicknameMirror(owner);
  revision++;
}

// ── A blocked person cannot rename the blocker ─────────────────────────────────────────────────
//
// A community refuses it at the server. An MLS group cannot: the server never reads the frame, and a
// block is PRIVATE, so no third member can know one stands between the setter and the target. The
// two parties who can are the setter (whose screen asks `block-status` before sending) and the
// TARGET, whose own devices check the setter of a nickname naming them before ever showing it. Until
// that answer arrives - or when it cannot be had - the target sees their own name: their own label is
// the one place an unchecked insult may not land.
//
// A FAILED ASK IS A STATE THE READ DEPENDS ON ('unknown'), cleared when the link comes back
// (`connectivity.onReconnect`): the next read then asks again. Never a timer, and never an unrelated
// re-render that happens to read the name.

// Keyed by VIEWER and setter: a verdict is about a pair, and an account switch must not inherit one.
const setterVerdicts = new SvelteMap<string, 'asking' | 'clear' | 'blocked' | 'unknown'>();
const pairKey = (viewer: string, setBy: string) => `${viewer}|${setBy}`;

connectivity.onReconnect(() => {
  for (const [key, verdict] of setterVerdicts) {
    if (verdict === 'unknown') setterVerdicts.delete(key);
  }
});

function askAboutSetter(viewer: string, setBy: string): void {
  const key = pairKey(viewer, setBy);
  if (setterVerdicts.has(key)) return;
  setterVerdicts.set(key, 'asking');
  void isBlockedWith(setBy).then(
    (blocked) => {
      setterVerdicts.set(key, blocked ? 'blocked' : 'clear');
      remirrorViewerEntriesBy(viewer, setBy);
      if (blocked) {
        console.info(
          `[NICKNAME] a nickname naming this account was set by ${setBy.slice(0, 8)}, with whom a block stands - not shown`
        );
      }
    },
    (e: unknown) => {
      setterVerdicts.set(key, 'unknown');
      remirrorViewerEntriesBy(viewer, setBy);
      console.warn(
        `[NICKNAME] could not ask whether a block stands with ${setBy.slice(0, 8)} - this account's own name is shown until the link comes back: ${String(e)}`
      );
    }
  );
}

/**
 * The nickname to SHOW for `userId` in `scope`, or null for none - the one reader the name resolver
 * (`displayName.ts`) consults. A nickname of the viewer is shown at once only when the viewer set it
 * themselves in an AUTHENTICATED statement; any other - somebody else's, or an unverified entry
 * claiming the viewer - waits until its setter is known not to stand in a block with the viewer.
 */
export function visibleNickname(scope: string | null | undefined, userId: string): string | null {
  return shownNickname(nicknameEntry(scope, userId), userId);
}

/**
 * The block rule both readers apply - {@link visibleNickname} (the screen, reactive) and
 * {@link mirroredNickname} (the notifications' copy): `entry` names `userId`, read by the caller.
 */
function shownNickname(entry: NicknameEntry | null | undefined, userId: string): string | null {
  if (!entry?.nickname) return null;
  const me = currentUserId();
  if (!me || norm(me) !== norm(userId)) return entry.nickname;
  const viewer = norm(me);
  if (entry.verified && entry.setBy === viewer) return entry.nickname;
  const verdict = setterVerdicts.get(pairKey(viewer, entry.setBy));
  if (verdict === 'clear') return entry.nickname;
  // The ask is a side effect of a READ, scheduled and written asynchronously, so it never mutates
  // state inside the reactive read that triggered it.
  if (verdict === undefined) queueMicrotask(() => askAboutSetter(viewer, entry.setBy));
  return null;
}

/**
 * Whether a nickname naming `userId` in `scope` is HIDDEN FROM THEM because its setter stands in a
 * block with them - known, not pending. While the block question is open (asked, or unanswerable
 * until the link comes back) this is false and the screen shows the plain name: never a notice
 * that might turn out wrong a moment later (review of #3177). Reactive.
 */
export function nicknameHiddenByBlock(scope: string | null | undefined, userId: string): boolean {
  const entry = nicknameEntry(scope, userId);
  const me = currentUserId();
  if (!entry?.nickname || !me || norm(me) !== norm(userId)) return false;
  return setterVerdicts.get(pairKey(norm(me), entry.setBy)) === 'blocked';
}

// ── Notifications: the device names members by their nickname (owner, 2026-11-14) ────────────────
//
// "comme sur Messenger, tous les pseudos": a notification names a member by the nickname set in THAT
// conversation, whoever set it, lock screen included - under the SAME block rule as the screen. The
// device composes the name, never a server: the WebView's own notifications read this register
// through `notificationSenderName` (`displayName.ts`) with {@link notificationNicknameScope}, and the
// native push path reads the copy mirrored here ({@link mirrorEntry}, `nicknameMirror.ts`).

/** Salon id (no `channel_` prefix) -> its community's workspace id, from the sidebar's list. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- read on demand, never drawn
const salonCommunities = new Map<string, string>();

/**
 * The nickname a NOTIFICATION gives `userId` in `scope`, or null - {@link visibleNickname}'s rule
 * without its reactivity: a nickname of the viewer set by somebody else is given only once its setter
 * is known not to stand in a block with them. While that is pending or unanswerable the answer is
 * null (the profile name, as on the screen), and the question is asked; its answer re-mirrors.
 */
export function mirroredNickname(scope: string, userId: string): string | null {
  return shownNickname(load(scope).get(norm(userId)), userId);
}

/** Notes `userId`'s entry in `scope` for the native copy, as a notification may show it. */
function mirrorEntry(scope: string, userId: string): void {
  noteMirroredNickname(scope, userId, mirroredNickname(scope, userId));
}

/** A block verdict about `setBy` changed what the viewer may see of their own entries: re-note them. */
function remirrorViewerEntriesBy(viewer: string, setBy: string): void {
  for (const [key, map] of registers) {
    if (!key.startsWith(`${viewer}|`)) continue;
    const entry = map.get(viewer);
    if (entry?.setBy === setBy) mirrorEntry(key.slice(viewer.length + 1), viewer);
  }
}

/**
 * Restates every register this account keeps on the device to the native copy - once per signed-in
 * session (`ChatBackgroundService`), so a copy written by an older build, by a previous account of
 * this install, or never written at all is brought in line. A community's register is the server's
 * and lives in memory only: it is mirrored as it is read, and its copy stays until the sign-out.
 * Returns how many entries were restated.
 */
export function mirrorStoredNicknames(): number {
  const owner = account();
  if (!owner) return 0;
  // Written even when this account holds nothing: the copy is this account's from now on.
  noteMirrorSessionStart();
  const prefix = ACCOUNT_KEY.conversationNicknames(owner, '');
  const scopes: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) scopes.push(key.slice(prefix.length));
    }
  } catch (e) {
    console.warn(`[NICKNAME] stored registers not listed for the notifications: ${String(e)}`);
    return 0;
  }
  let restated = 0;
  for (const scope of scopes) restated += restateMirroredScope(scope);
  console.info(
    `[NICKNAME] ${restated} nickname(s) of ${scopes.length} conversation(s) restated for the notifications`
  );
  return restated;
}

/**
 * Restates `scope`'s whole register to the native copy: what the copy held there and the register no
 * longer does is removed. A community's list read from the server (`loadCommunityNicknames`) ends
 * with it - after a relaunch the register starts empty, so a member the list stopped naming (who
 * left, or whose membership was created afresh) would otherwise keep the old nickname in the copy,
 * and a notification would show what the screen no longer does. Returns how many entries it noted.
 */
export function restateMirroredScope(scope: string): number {
  noteMirroredScopeRestated(scope);
  let noted = 0;
  for (const userId of load(scope).keys()) {
    mirrorEntry(scope, userId);
    noted++;
  }
  return noted;
}

/** The account {@link salonCommunities} was built for: an account switch starts it afresh. */
let salonsPlacedFor = '';

/**
 * Places every salon in its community, from the sidebar's list: what lets a salon's notification
 * read its COMMUNITY's register - here ({@link notificationNicknameScope}) and natively (the push
 * names the salon only). A salon no longer listed is forgotten. Run on every change of the list.
 */
export function noteSalonCommunities(
  workspaces: ReadonlyArray<{ workspaceDbId?: string; channels: ReadonlyArray<{ id: string }> }>
): void {
  // ONE ACCOUNT'S PLACEMENTS: the diff below notes only what changed, so a salon the previous
  // account of the install also had would otherwise never be noted for this one, whose copy starts
  // afresh - and its notifications would never read the community's nicknames.
  const who = account();
  if (who !== salonsPlacedFor) {
    salonCommunities.clear();
    salonsPlacedFor = who;
  }
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a local diff, never drawn
  const next = new Map<string, string>();
  for (const ws of workspaces) {
    if (!ws.workspaceDbId) continue;
    for (const ch of ws.channels) next.set(ch.id.replace(/^channel_/, ''), ws.workspaceDbId);
  }
  let changed = 0;
  for (const [id, ws] of next) {
    if (salonCommunities.get(id) === ws) continue;
    salonCommunities.set(id, ws);
    noteMirroredSalon(id, communityNicknameScope(ws));
    changed++;
  }
  // Deleting the entry being visited is defined for a Map's iterator: no copy is needed.
  for (const id of salonCommunities.keys()) {
    if (next.has(id)) continue;
    salonCommunities.delete(id);
    noteMirroredSalon(id, null);
    changed++;
  }
  if (changed > 0) console.debug(`[NICKNAME] ${changed} salon placement(s) changed`);
}

/**
 * The scope a NOTIFICATION about `conversationKey` reads its nicknames in: a salon (`channel_<id>`,
 * or a conversation typed `channel`) its community's, an MLS conversation its own key. Null for a
 * salon whose community this device has not placed yet - the profile name, said at debug.
 */
export function notificationNicknameScope(
  conversationKey: string,
  conversationType?: 'direct' | 'group' | 'channel'
): string | null {
  if (!conversationKey) return null;
  if (conversationType !== 'channel' && !conversationKey.startsWith('channel_')) {
    return conversationKey;
  }
  const ws =
    salonsPlacedFor === account()
      ? salonCommunities.get(conversationKey.replace(/^channel_/, ''))
      : undefined;
  if (!ws) {
    console.debug(
      `[NICKNAME] salon ${conversationKey.slice(0, 16)} not placed in a community - its notification names the profile`
    );
    return null;
  }
  return communityNicknameScope(ws);
}

/** Test seam: forgets every register and verdict, as a fresh page would. */
export function resetConversationNicknamesForTests(): void {
  registers.clear();
  setterVerdicts.clear();
  salonCommunities.clear();
  salonsPlacedFor = '';
  revision++;
}
