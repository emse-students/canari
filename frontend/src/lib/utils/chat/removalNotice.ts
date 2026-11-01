/**
 * THE "YOU WERE REMOVED" LINE: dated by the removal, written once, and OWED - durably - until the
 * server answers when the removal happened.
 *
 * The row is retired before the line's date is asked (`recordEviction`: the banner is the durable
 * half and never waits), and a retired row receives no further evidence. So a question that got no
 * answer - a route this server does not serve yet (`unserved`), or no answer at all - cannot be left
 * to "a later evidence": it is recorded HERE, per account, and asked again at the next evidence for
 * the group and, at the latest, once the next session's restore has rebuilt the map
 * ({@link drainOwedRemovalNotices}). Only an ANSWER settles it: the instant (the line is written), or
 * the server holding no record (`none`, `refused` - said once, at ERROR, and never asked again).
 *
 * Per account, in `localStorage` like every per-account record (`accountLocalKeys.ts`).
 */
import { accountStore } from '$lib/mls-client/accountStore';
import type { ServerInstant } from '$lib/mls-client/serverInstant';
import { m } from '$lib/paraglide/messages';
import type { AddMessageToChatOptions, Conversation } from '$lib/types';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { findConversationKeyByGroupId } from '$lib/utils/chat/conversations';

/** Writes a row into a conversation - `addMessageToChat`, as every caller already holds it. */
type NoticeWriter = (
  senderId: string,
  content: string,
  contactName: string,
  options?: AddMessageToChatOptions
) => Promise<void>;

/**
 * The id of the removal line: one per group and removal instant, so two evidences of the same removal
 * landing together write ONE row, and a later removal (after a re-admission) writes its own.
 */
export function removalNoticeId(groupId: string, removedAt: number): string {
  return `evicted:${groupId}:${removedAt}`;
}

/** Groups whose removal the server ANSWERED with no instant: not asked again this session. */
const undatable = new Set<string>();

function readOwed(ownerId: string): string[] {
  const s = accountStore();
  if (!s) return [];
  try {
    const parsed: unknown = JSON.parse(s.getItem(ACCOUNT_KEY.owedRemovalNotices(ownerId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === 'string') : [];
  } catch (e) {
    console.error(
      `[EVICT] the owed removal notices are UNREADABLE - none is asked again: ${String(e).slice(0, 120)}`
    );
    return [];
  }
}

function writeOwed(ownerId: string, groups: string[]): void {
  const s = accountStore();
  if (!s) return;
  const key = ACCOUNT_KEY.owedRemovalNotices(ownerId);
  try {
    if (groups.length > 0) s.setItem(key, JSON.stringify(groups));
    else s.removeItem(key);
  } catch (e) {
    console.error(
      `[EVICT] the owed removal notices were NOT written - an owed line is asked again only this session: ${String(e).slice(0, 120)}`
    );
  }
}

/** Whether a removal line is owed in `groupId` for `ownerId`. */
export function owesRemovalNotice(ownerId: string, groupId: string): boolean {
  return readOwed(ownerId).includes(groupId);
}

function owe(ownerId: string | undefined, groupId: string): void {
  if (!ownerId) return;
  const owed = readOwed(ownerId);
  if (!owed.includes(groupId)) writeOwed(ownerId, [...owed, groupId]);
}

function settle(ownerId: string | undefined, groupId: string): void {
  if (!ownerId) return;
  const owed = readOwed(ownerId);
  if (owed.includes(groupId))
    writeOwed(
      ownerId,
      owed.filter((g) => g !== groupId)
    );
}

/** What {@link writeRemovalNotice} needs. */
export interface RemovalNoticeDeps {
  conversations: Map<string, Conversation>;
  /** The conversations-map key of the retired row. */
  key: string;
  groupId: string;
  /** The account the owed record belongs to; without it an owed line lives only in this session. */
  ownerId?: string;
  /** The evidence's own time of the removal (server ms), when it carries one. */
  removedAt?: number;
  /** Asks the server when this device's own seat was removed (`IMlsService.ownRemovalAt`). */
  askRemovedAt?: () => Promise<ServerInstant>;
  addMessageToChat: NoticeWriter;
  /** Whether this call may SAY a refusal or an owed line - the call that retired the row, or the drain. */
  speak: boolean;
  /** How this was learnt, for the log. */
  label: string;
  log: (message: string) => void;
}

/**
 * Writes the removal line if its instant is known or answered, and otherwise records what the answer
 * means: settled for good, or owed. Returns what became of it. Never throws.
 */
export async function writeRemovalNotice(
  deps: RemovalNoticeDeps
): Promise<'written' | 'settled' | 'owed'> {
  const { groupId, ownerId, removedAt, askRemovedAt, speak, label, log } = deps;
  const short = groupId.slice(0, 8);
  let at: number | null =
    typeof removedAt === 'number' && Number.isFinite(removedAt) && removedAt > 0 ? removedAt : null;
  if (at === null) {
    if (undatable.has(groupId)) {
      settle(ownerId, groupId);
      return 'settled';
    }
    let why: string;
    if (!askRemovedAt) {
      why = 'this evidence carries no time and its site cannot ask the server';
    } else {
      try {
        const answer = await askRemovedAt();
        if (answer.kind === 'at') at = answer.at;
        else if (answer.kind === 'unserved') {
          why = 'this server does not serve the own-removal route yet';
        } else {
          // AN ANSWER: there is no instant, and asking again would answer the same.
          undatable.add(groupId);
          settle(ownerId, groupId);
          if (speak) {
            console.error(
              `[EVICT] ${short}… - removal notice REFUSED (${label}): the server holds no instant of this seat's removal (${answer.kind}), and this device's clock is not one; the retired row's banner tells the user`
            );
          }
          return 'settled';
        }
      } catch (e) {
        why = `the server gave no answer (${String(e).slice(0, 80)})`;
      }
    }
    if (at === null) {
      owe(ownerId, groupId);
      if (speak) {
        console.warn(
          `[EVICT] ${short}… - removal notice OWED (${label}): ${why!} - asked again at the next evidence, and after the next restore`
        );
      }
      return 'owed';
    }
  }
  try {
    await deps.addMessageToChat('system', m.chat_system_removed_from_group(), deps.key, {
      isSystem: true,
      messageId: removalNoticeId(groupId, at),
      timestamp: new Date(at),
      serverTimestamp: at,
    });
  } catch (e) {
    // The banner is the durable half; a line that could not be written is said, and kept owed.
    owe(ownerId, groupId);
    log(`[EVICT] ${short}… - removal notice not posted, kept owed: ${String(e)}`);
    return 'owed';
  }
  settle(ownerId, groupId);
  return 'written';
}

/**
 * Asks again for every removal line `ownerId` is owed, once the restore has rebuilt the map: a
 * retired row receives no further evidence, so this is the "next session" half of the owed contract.
 * A group whose row is gone, or no longer `removed` (a re-admission), or already holds the line, is
 * settled without a word to the server.
 */
export async function drainOwedRemovalNotices(deps: {
  ownerId: string;
  conversations: Map<string, Conversation>;
  askRemovedAt: (groupId: string) => Promise<ServerInstant>;
  addMessageToChat: NoticeWriter;
  log: (message: string) => void;
}): Promise<void> {
  const owed = readOwed(deps.ownerId);
  if (owed.length === 0) return;
  console.log(`[EVICT] ${owed.length} owed removal notice(s) asked again after the restore`);
  const notice = m.chat_system_removed_from_group();
  for (const groupId of owed) {
    const key = findConversationKeyByGroupId(deps.conversations, groupId);
    const row = key ? deps.conversations.get(key) : undefined;
    if (!key || !row || row.lifecycle !== 'removed') {
      settle(deps.ownerId, groupId);
      deps.log(
        `[EVICT] ${groupId.slice(0, 8)}… - owed removal notice dropped: the row is ${row ? row.lifecycle : 'gone'}`
      );
      continue;
    }
    if (row.messages.some((msg) => msg.isSystem && msg.content === notice)) {
      settle(deps.ownerId, groupId);
      continue;
    }
    await writeRemovalNotice({
      conversations: deps.conversations,
      key,
      groupId,
      ownerId: deps.ownerId,
      askRemovedAt: () => deps.askRemovedAt(groupId),
      addMessageToChat: deps.addMessageToChat,
      speak: true,
      label: 'owed, after the restore',
      log: deps.log,
    });
  }
}
