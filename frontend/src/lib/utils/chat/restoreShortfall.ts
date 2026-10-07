import type { Conversation } from '$lib/types';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';

/**
 * What a startup restore owed against what it delivered, as a TYPE.
 *
 * The restore reads two things that must agree: the local store (the conversation rows) and the MLS
 * state (the groups the WASM client holds). A row the store restored as `active` is a promise that
 * this device can read and write it, so it EXPECTS its MLS group. When the group is absent the row
 * is on screen and cannot work - a partial restore that looks complete, which is worse than none
 * because nothing tells the user to act. The counts travel with the result so the report can say
 * how much is missing rather than only that something is.
 */
export interface RestoreShortfall {
  /** Rows the store restored as `active`, hence owed an MLS group (channels excluded). */
  expected: number;
  /** Of those, the ones whose MLS group is held locally. */
  restored: number;
  /** The rows owed a group and lacking it - what the log names, never shown to the user. */
  missingIds: string[];
}

/**
 * Compares what the startup restore delivered with what it owed.
 *
 * Classified HERE, from the rows and the group set, rather than from any message: the one place
 * that holds both facts is the one that can say they disagree. `pending` rows are not counted as
 * owed - they already declare that they wait for a Welcome - so a device restored from another
 * device's backup (all `pending`) reports nothing, and a row demoted by a previous startup is not
 * re-reported for ever.
 *
 * @param conversations every row the restore put in the map
 * @param localGroups the MLS group ids the client holds
 * @returns the shortfall, or `null` when every owed group is held (or nothing was owed)
 */
export function measureRestoreShortfall(
  conversations: Iterable<Pick<Conversation, 'id' | 'lifecycle'>>,
  localGroups: ReadonlySet<string>
): RestoreShortfall | null {
  let expected = 0;
  const missingIds: string[] = [];
  for (const c of conversations) {
    if (isChannelConversationId(c.id) || c.lifecycle !== 'active') continue;
    expected++;
    if (!localGroups.has(c.id)) missingIds.push(c.id);
  }
  if (missingIds.length === 0) return null;
  return { expected, restored: expected - missingIds.length, missingIds };
}
