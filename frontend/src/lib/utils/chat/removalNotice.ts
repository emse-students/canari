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
 * the server holding no record (`none`, `refused` - said once, at ERROR, and not asked again this
 * session for this account).
 *
 * A REMOVAL CAN BE UNDONE WHILE ITS DATE IS ASKED (a Welcome installs during the await), and
 * `retractEvictionNotice` then finds nothing to withdraw. So the row is re-read after every await,
 * and the line is written only while it is still `removed` and does not already hold THIS removal's
 * line - the 2026-09-22 rule (a false "you were removed" above a working conversation) kept across
 * the ask. A line left by an EARLIER removal (a re-admission came between) is not this one's: the
 * evidence that retires the row names the lines already there ({@link removalLineIds}).
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
 * The id of the removal line: one per group and removal instant, so a later removal (after a
 * re-admission) writes its own row. Two evidences of the SAME removal do not rely on it - they carry
 * different instants (the Remove commit's delivery, the announcement's) - but on
 * {@link writeRemovalNotice} running ONE write at a time per group and re-reading the thread.
 */
export function removalNoticeId(groupId: string, removedAt: number): string {
  return `evicted:${groupId}:${removedAt}`;
}

/**
 * `ownerId:groupId` of the removals the server ANSWERED with no instant: not asked again this
 * session. Per account, and emptied when the session ends ({@link forgetRemovalNotices}).
 */
const undatable = new Set<string>();

/** The write in flight per `ownerId:groupId`: two evidences landing together write one after the other. */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Per `ownerId:groupId`, the removal lines the thread held when THIS removal retired the row: an
 * earlier removal's (a re-admission came between), which never stand for this one's. Kept in the
 * owed record too, so the next session tells them apart. Unknown (a removal retired by an earlier
 * session and not owed) reads as none: every removal line in the thread then counts.
 */
const earlierLinesOf = new Map<string, ReadonlySet<string>>();

/** Ends the session's memory of answered removals: called when the account signs out or switches. */
export function forgetRemovalNotices(): void {
  undatable.clear();
  earlierLinesOf.clear();
}

const scopeOf = (ownerId: string | undefined, groupId: string) => `${ownerId ?? '-'}:${groupId}`;

/** The ids of the "you were removed" lines a row holds. */
export function removalLineIds(row: Pick<Conversation, 'messages'> | undefined): string[] {
  if (!row) return [];
  const notice = m.chat_system_removed_from_group();
  return row.messages.filter((msg) => msg.isSystem && msg.content === notice).map((msg) => msg.id);
}

/** The owed record: per group, the earlier removal lines that are not this removal's. */
type OwedRecord = Record<string, string[]>;

function readOwed(ownerId: string): OwedRecord {
  const s = accountStore();
  if (!s) return {};
  try {
    const parsed: unknown = JSON.parse(s.getItem(ACCOUNT_KEY.owedRemovalNotices(ownerId)) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const owed: OwedRecord = {};
    for (const [groupId, ids] of Object.entries(parsed)) {
      owed[groupId] = Array.isArray(ids)
        ? ids.filter((x): x is string => typeof x === 'string')
        : [];
    }
    return owed;
  } catch (e) {
    console.error(
      `[EVICT] the owed removal notices are UNREADABLE - none is asked again: ${String(e).slice(0, 120)}`
    );
    return {};
  }
}

function writeOwed(ownerId: string, owed: OwedRecord): void {
  const s = accountStore();
  if (!s) return;
  const key = ACCOUNT_KEY.owedRemovalNotices(ownerId);
  try {
    if (Object.keys(owed).length > 0) s.setItem(key, JSON.stringify(owed));
    else s.removeItem(key);
  } catch (e) {
    console.error(
      `[EVICT] the owed removal notices were NOT written - an owed line is asked again only this session: ${String(e).slice(0, 120)}`
    );
  }
}

/** Whether a removal line is owed in `groupId` for `ownerId`. */
export function owesRemovalNotice(ownerId: string, groupId: string): boolean {
  return groupId in readOwed(ownerId);
}

function owe(ownerId: string | undefined, groupId: string): void {
  if (!ownerId) return;
  const owed = readOwed(ownerId);
  const earlier = [...(earlierLinesOf.get(scopeOf(ownerId, groupId)) ?? [])];
  writeOwed(ownerId, { ...owed, [groupId]: earlier });
}

function settle(ownerId: string | undefined, groupId: string): void {
  if (!ownerId) return;
  const owed = readOwed(ownerId);
  if (!(groupId in owed)) return;
  delete owed[groupId];
  writeOwed(ownerId, owed);
}

/** The earlier removals' lines for `scope`: this session's memory, else the owed record's. */
function earlierLines(ownerId: string | undefined, groupId: string): ReadonlySet<string> {
  const known = earlierLinesOf.get(scopeOf(ownerId, groupId));
  if (known) return known;
  return new Set(ownerId ? (readOwed(ownerId)[groupId] ?? []) : []);
}

/**
 * Why the line may no longer be written into `groupId`'s row - `gone` when the row left the map,
 * which only the session can say the meaning of - or `null` when it still may.
 */
function noLongerOwed(
  conversations: Map<string, Conversation>,
  ownerId: string | undefined,
  groupId: string
): string | 'gone' | null {
  const key = findConversationKeyByGroupId(conversations, groupId);
  const row = key ? conversations.get(key) : undefined;
  if (!row) return 'gone';
  if (row.lifecycle !== 'removed') return `the row is ${row.lifecycle ?? 'active'} again`;
  const earlier = earlierLines(ownerId, groupId);
  if (removalLineIds(row).some((id) => !earlier.has(id))) {
    return 'the thread already holds the line of this removal';
  }
  return null;
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
  /**
   * Whether the session that started this is still the signed-in one; a retired one writes nothing.
   * Without it, a row gone from the map is not taken for a deleted conversation: the sign-out clears
   * the map, and settling then would erase the leaving account's owed record. The line stays owed,
   * and the next restore's drain (which passes it) decides.
   */
  isCurrent?: () => boolean;
  /**
   * The removal lines the thread held before THIS evidence retired the row - an earlier removal's.
   * Passed only by the evidence that retired it.
   */
  earlierLines?: readonly string[];
}

/**
 * Writes the removal line if its instant is known or answered, and otherwise records what the answer
 * means: settled for good, or owed. Returns what became of it. Never throws. One write at a time per
 * account and group.
 */
export function writeRemovalNotice(
  deps: RemovalNoticeDeps
): Promise<'written' | 'settled' | 'owed' | 'stale'> {
  const scope = scopeOf(deps.ownerId, deps.groupId);
  const previous = inFlight.get(scope) ?? Promise.resolve();
  // The next write runs whatever became of the previous one: a throw must not reject every write
  // queued behind it.
  const now = () => writeRemovalNoticeNow(deps);
  const run = previous.then(now, now);
  inFlight.set(scope, run);
  run
    .catch((e: unknown) =>
      console.error(
        `[EVICT] ${deps.groupId.slice(0, 8)}… - removal notice write THREW: ${String(e)}`
      )
    )
    .finally(() => {
      if (inFlight.get(scope) === run) inFlight.delete(scope);
    });
  return run;
}

async function writeRemovalNoticeNow(
  deps: RemovalNoticeDeps
): Promise<'written' | 'settled' | 'owed' | 'stale'> {
  const { conversations, groupId, ownerId, removedAt, askRemovedAt, speak, label, log } = deps;
  const short = groupId.slice(0, 8);
  const scope = scopeOf(ownerId, groupId);
  if (deps.earlierLines) earlierLinesOf.set(scope, new Set(deps.earlierLines));
  /** Re-read after every await: the session may have ended, the removal been undone, the line written. */
  const recheck = (): 'stale' | 'settled' | null => {
    if (deps.isCurrent && !deps.isCurrent()) {
      log(`[EVICT] ${short}… - removal notice not written (${label}): the session ended meanwhile`);
      return 'stale';
    }
    const why = noLongerOwed(conversations, ownerId, groupId);
    if (why === null) return null;
    if (why === 'gone' && !deps.isCurrent) {
      log(
        `[EVICT] ${short}… - removal notice not written (${label}): the row left the map - kept owed for the next restore to decide`
      );
      return 'stale';
    }
    settle(ownerId, groupId);
    log(
      `[EVICT] ${short}… - removal notice not written (${label}): ${why === 'gone' ? 'the row is gone' : why}`
    );
    return 'settled';
  };
  const before = recheck();
  if (before) return before;

  let at: number | null =
    typeof removedAt === 'number' && Number.isFinite(removedAt) && removedAt > 0 ? removedAt : null;
  if (at === null) {
    if (undatable.has(scope)) {
      settle(ownerId, groupId);
      log(
        `[EVICT] ${short}… - removal notice not asked (${label}): the server already answered this session that it holds no instant of this removal`
      );
      return 'settled';
    }
    let why: string;
    if (!askRemovedAt) {
      why = 'this evidence carries no time and its site cannot ask the server';
    } else {
      try {
        const answer = await askRemovedAt();
        const after = recheck();
        if (after) return after;
        if (answer.kind === 'at') at = answer.at;
        else if (answer.kind === 'unserved') {
          why = 'this server does not serve the own-removal route yet';
        } else {
          // AN ANSWER: there is no instant, and asking again would answer the same.
          undatable.add(scope);
          settle(ownerId, groupId);
          if (speak) {
            console.error(
              `[EVICT] ${short}… - removal notice REFUSED (${label}): the server holds no instant of this seat's removal (${answer.kind}), and this device's clock is not one; the retired row's banner tells the user`
            );
          }
          return 'settled';
        }
      } catch (e) {
        const after = recheck();
        if (after) return after;
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
  const key = findConversationKeyByGroupId(conversations, groupId) ?? deps.key;
  try {
    await deps.addMessageToChat('system', m.chat_system_removed_from_group(), key, {
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
 * settled without a word to the server - and re-read after the answer, by {@link writeRemovalNotice}.
 * Stops as soon as the session that started it ends (`isCurrent`).
 */
export async function drainOwedRemovalNotices(deps: {
  ownerId: string;
  conversations: Map<string, Conversation>;
  askRemovedAt: (groupId: string) => Promise<ServerInstant>;
  addMessageToChat: NoticeWriter;
  log: (message: string) => void;
  isCurrent: () => boolean;
}): Promise<void> {
  const owed = Object.keys(readOwed(deps.ownerId));
  if (owed.length === 0) return;
  console.log(`[EVICT] ${owed.length} owed removal notice(s) asked again after the restore`);
  for (const groupId of owed) {
    if (!deps.isCurrent()) {
      deps.log('[EVICT] owed removal notices: the session ended - the rest stay owed');
      return;
    }
    const key = findConversationKeyByGroupId(deps.conversations, groupId);
    const outcome = await writeRemovalNotice({
      conversations: deps.conversations,
      key: key ?? groupId,
      groupId,
      ownerId: deps.ownerId,
      askRemovedAt: () => deps.askRemovedAt(groupId),
      addMessageToChat: deps.addMessageToChat,
      speak: true,
      label: 'owed, after the restore',
      log: deps.log,
      isCurrent: deps.isCurrent,
    });
    if (outcome === 'stale') return;
  }
}
