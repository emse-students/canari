import { channelService } from '$lib/services/ChannelService';
import { refusalCode } from '$lib/utils/apiRefusal';
import { isBlockedWith, USER_BLOCKED_CODE } from '$lib/users/blocks';
import {
  applyNickname,
  boundedNicknameAt,
  communityNicknameScope,
  dropNickname,
  nicknameEntries,
  nicknameEntry,
  nicknameSupersedes,
  restateMirroredScope,
} from '$lib/utils/users/conversationNicknames.svelte';
import { NICKNAME_TOO_LONG, normalizeNickname } from '$lib/utils/users/nicknameRules';
import { mayNameMember } from './nicknamePermission';

/**
 * Where a nickname is being changed: an MLS room (its register's scope and the sender of its silent
 * frame), or a community (its id and the viewer's moderation DECISION).
 */
export type NicknamePlace =
  | {
      kind: 'group';
      /** The MLS group id - the register's scope. */
      scope: string;
      /** Queues the `nickname` frame (`setConversationNickname`); false = the queue refused it. */
      send: (userId: string, nickname: string | null, at: number) => Promise<boolean>;
    }
  | { kind: 'community'; workspaceId: string; canModerate: boolean };

/**
 * What one change came to - each a sentence on the screen, none read out of a message:
 * `saved`; `too_long` (the profile's limit); `not_allowed` (no moderation grant, community);
 * `blocked` (a block stands between viewer and member); `not_member`; `not_queued` (the durable queue
 * refused the frame: nothing changed, here or elsewhere); `superseded` (a statement this device
 * holds is dated later than this change could be, so it would lose everywhere - nothing is sent);
 * `failed` (no answer).
 */
export type NicknameOutcome =
  | 'saved'
  | 'too_long'
  | 'not_allowed'
  | 'blocked'
  | 'not_member'
  | 'not_queued'
  | 'superseded'
  | 'failed';

/**
 * Sets - or, with an empty value, clears - `targetId`'s nickname in `place`, from the screen.
 *
 * In this order, each step a FACT asked before anything is changed: the value against the
 * profile's limits; the rule (`mayNameMember`); a block between the two people (`block-status`,
 * which the server re-checks in a community and which nothing else can check in a group). Then, in a
 * group, the frame is QUEUED FIRST and the register moved only once the queue took it - one instant
 * for both - so a refused frame leaves no local name the other members will never see. In a
 * community the server's answer is what the register takes.
 */
export async function saveNickname(
  place: NicknamePlace,
  viewerId: string,
  targetId: string,
  raw: string
): Promise<NicknameOutcome> {
  const viewer = viewerId.trim().toLowerCase();
  const target = targetId.trim().toLowerCase();
  const normalized = normalizeNickname(raw);
  if (!normalized.ok) return 'too_long';
  const nickname = normalized.value;
  const standing =
    place.kind === 'community'
      ? { inCommunity: true, canModerate: place.canModerate }
      : { inCommunity: false, canModerate: false };
  if (!mayNameMember(standing, { isSelf: viewer === target, isReset: nickname === null })) {
    console.warn(`[NICKNAME] not sent: the viewer may not name ${target.slice(0, 8)} here`);
    return 'not_allowed';
  }
  if (viewer !== target) {
    try {
      if (await isBlockedWith(target)) {
        console.info(`[NICKNAME] not sent: a block stands with ${target.slice(0, 8)}`);
        return 'blocked';
      }
    } catch (e) {
      // A failure to ASK is not an answer: nothing is sent on a guess.
      console.warn(
        `[NICKNAME] not sent: block status of ${target.slice(0, 8)} unknown: ${String(e)}`
      );
      return 'failed';
    }
  }

  if (place.kind === 'group') {
    // DATED TO WIN, AND CHECKED TO WIN BEFORE IT IS SENT (review of #3177). A held entry may be dated
    // ahead of this clock (a peer's, up to the server's time plus the skew), so the change is dated
    // just past it; peers bound that date by their server time, and the local apply is bounded the
    // same way, by the best server time this device has - its own clock at the send. A change that
    // would still lose is not sent and not called saved.
    const now = Date.now();
    const held = nicknameEntry(place.scope, target);
    const at = Math.max(now, (held?.at ?? 0) + 1);
    const local = { nickname, setBy: viewer, at: boundedNicknameAt(at, now), verified: true };
    if (held && !nicknameSupersedes(local, held)) {
      console.warn(
        `[NICKNAME] not sent: a statement about ${target.slice(0, 8)} dated ${held.at} outranks this change (bounded to ${local.at})`
      );
      return 'superseded';
    }
    const queued = await place.send(target, nickname, at);
    if (!queued) return 'not_queued';
    if (!applyNickname(place.scope, target, local)) {
      // Something newer landed while the frame was being queued: the frame is out, but this device
      // already shows a later statement, and the screen says so rather than "saved".
      console.warn(
        `[NICKNAME] ${target.slice(0, 8)}: a newer statement landed during the send - this change does not show`
      );
      return 'superseded';
    }
    console.info(
      `[NICKNAME] ${target.slice(0, 8)} ${nickname === null ? 'reset' : 'renamed'} in ${place.scope.slice(0, 8)}…`
    );
    return 'saved';
  }

  try {
    const entry = await channelService.setCommunityNickname(place.workspaceId, target, nickname);
    eventMarks.set(markKey(place.workspaceId, entry.userId), ++eventCounter);
    applyNickname(communityNicknameScope(place.workspaceId), entry.userId, entry);
    console.info(
      `[NICKNAME] ${target.slice(0, 8)} ${nickname === null ? 'cleared' : 'set'} in community ${place.workspaceId.slice(0, 8)}`
    );
    return 'saved';
  } catch (e) {
    const code = refusalCode(e);
    console.warn(`[NICKNAME] community write refused (${code ?? 'no code'}): ${String(e)}`);
    if (code === NICKNAME_TOO_LONG) return 'too_long';
    if (code === 'NICKNAME_REQUIRES_MODERATION') return 'not_allowed';
    if (code === USER_BLOCKED_CODE) return 'blocked';
    if (code === 'NICKNAME_TARGET_NOT_MEMBER') return 'not_member';
    return 'failed';
  }
}

// A COMMUNITY'S LIST IS THE SERVER'S WHOLE REGISTER, and it must be able to CLEAR: a member who left,
// or whose membership was created afresh (its `nicknameSetAt` NULL), is absent from it, and the entry
// this device held for them goes. But an event that arrived WHILE the list was in flight is newer
// than the list, so what it touched is kept: each event bumps the member's mark, and a drop needs a
// mark not newer than the list's start. Ordering by a counter, never by a clock.
const eventMarks = new Map<string, number>();
let eventCounter = 0;
/** The latest list read started per community - see `loadCommunityNicknames`. */
const listReads = new Map<string, number>();
const markKey = (workspaceId: string, userId: string) =>
  `${workspaceId}|${userId.trim().toLowerCase()}`;

/**
 * Reads a community's list into its register: each entry applied by date, and every member the list
 * does not name dropped unless a live event touched them since the read began (see above). Returns
 * false when it could not be read; the register keeps what it held, and that is said here.
 */
export async function loadCommunityNicknames(workspaceId: string): Promise<boolean> {
  const startedAt = eventCounter;
  // ONE SEQUENCE PER READ: two reads may overlap (a reconnect while the screen opens one), and the
  // answer of the older must never overwrite the newer's - it is dropped when a later read began.
  const seq = (listReads.get(workspaceId) ?? 0) + 1;
  listReads.set(workspaceId, seq);
  let entries: Awaited<ReturnType<typeof channelService.listCommunityNicknames>>;
  try {
    entries = await channelService.listCommunityNicknames(workspaceId);
  } catch (e) {
    console.warn(
      `[NICKNAME] nicknames of community ${workspaceId.slice(0, 8)} unreadable - names show as profiles until the next read: ${String(e)}`
    );
    return false;
  }
  if (listReads.get(workspaceId) !== seq) {
    console.debug(
      `[NICKNAME] list of community ${workspaceId.slice(0, 8)} superseded by a later read - dropped`
    );
    return true;
  }
  const scope = communityNicknameScope(workspaceId);
  const named = new Set<string>();
  for (const entry of entries) {
    named.add(entry.userId.trim().toLowerCase());
    applyNickname(scope, entry.userId, entry);
  }
  let dropped = 0;
  for (const held of nicknameEntries(scope)) {
    if (named.has(held.userId)) continue;
    if ((eventMarks.get(markKey(workspaceId, held.userId)) ?? 0) > startedAt) continue;
    if (dropNickname(scope, held.userId)) dropped++;
  }
  if (dropped > 0) {
    console.info(
      `[NICKNAME] ${dropped} nickname(s) of community ${workspaceId.slice(0, 8)} no longer on the server - dropped`
    );
  }
  // The notifications' copy outlives this in-memory register across launches: it is restated whole,
  // so what the list no longer names leaves it too (`restateMirroredScope`).
  restateMirroredScope(scope);
  return true;
}

/** Applies the `nickname` a `workspace.updated` event carries, to the community's register. */
export function applyCommunityNicknameEvent(workspaceId: string, raw: unknown): void {
  const entry = raw as { userId?: unknown } | null;
  if (!workspaceId || !entry || typeof entry.userId !== 'string') {
    console.error(
      `[NICKNAME] a workspace.updated nickname names nobody (community ${workspaceId.slice(0, 8) || 'none'}) - lost`
    );
    return;
  }
  eventMarks.set(markKey(workspaceId, entry.userId), ++eventCounter);
  applyNickname(
    communityNicknameScope(workspaceId),
    entry.userId,
    entry as Parameters<typeof applyNickname>[2]
  );
}
