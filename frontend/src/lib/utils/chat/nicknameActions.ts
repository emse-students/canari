import { channelService } from '$lib/services/ChannelService';
import { refusalCode } from '$lib/utils/apiRefusal';
import { isBlockedWith, USER_BLOCKED_CODE } from '$lib/users/blocks';
import {
  applyNickname,
  communityNicknameScope,
  mergeNicknameEntries,
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
 * refused the frame: nothing changed, here or elsewhere); `failed` (no answer).
 */
export type NicknameOutcome =
  | 'saved'
  | 'too_long'
  | 'not_allowed'
  | 'blocked'
  | 'not_member'
  | 'not_queued'
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
    const at = Date.now();
    const queued = await place.send(target, nickname, at);
    if (!queued) return 'not_queued';
    applyNickname(place.scope, target, { nickname, setBy: viewer, at });
    console.info(
      `[NICKNAME] ${target.slice(0, 8)} ${nickname === null ? 'reset' : 'renamed'} in ${place.scope.slice(0, 8)}…`
    );
    return 'saved';
  }

  try {
    const entry = await channelService.setCommunityNickname(place.workspaceId, target, nickname);
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

/**
 * Merges the server's list into a community's register (by date - see `conversationNicknames`).
 * Returns false when it could not be read; the register keeps what it held, and that is said here.
 */
export async function loadCommunityNicknames(workspaceId: string): Promise<boolean> {
  try {
    const entries = await channelService.listCommunityNicknames(workspaceId);
    mergeNicknameEntries(communityNicknameScope(workspaceId), entries);
    return true;
  } catch (e) {
    console.warn(
      `[NICKNAME] nicknames of community ${workspaceId.slice(0, 8)} unreadable - names show as profiles until the next read: ${String(e)}`
    );
    return false;
  }
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
  applyNickname(
    communityNicknameScope(workspaceId),
    entry.userId,
    entry as Parameters<typeof applyNickname>[2]
  );
}
