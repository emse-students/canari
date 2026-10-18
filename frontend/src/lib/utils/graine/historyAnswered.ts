/**
 * THE HISTORY ASKS ANSWERED "I HOLD NOTHING", durably (channel-encryption section 24).
 *
 * A device that holds no seed of a community asks one member for its past at every start
 * (`requestCommunityHistory`). An answerer holding nothing used to answer by silence, so the
 * requester had nothing to record and asked again at the next launch, for ever - eight sealed
 * requests and eight roster reads per launch on the Mi 9T, 2026-10-15. The answer is now explicit
 * (`GraineBundleMsg.holds_nothing`), and THIS is where it is kept, so the next launch reads it
 * instead of asking.
 *
 * **What the record answers, and only that:** "the member asked for this community's past, at this
 * key group and this distribution epoch, said it holds nothing". The epoch is the version of the
 * roster (every membership change commits to the key group), so a record whose epoch the group has
 * left answers nothing and the next start asks again - the same version `historyUnanswerableAt`
 * keys "nobody to ask" on. No clock is involved anywhere.
 *
 * In `localStorage` per account, like `sendRatchetLedger`: a few bytes, read synchronously, and
 * it survives a restart, which is the whole point. A storage that refuses the read is logged and
 * read as no record, which ASKS - the reading that costs a request rather than a past.
 */

const KEY_PREFIX = 'canari_graine_history_held_nothing:v1:';

/** Where a history ask was answered "I hold nothing": the key group, and the epoch it was sealed at. */
export interface HistoryHeldNothing {
  groupId: string;
  epoch: number;
}

type Records = Record<string, HistoryHeldNothing>;

function keyFor(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

/** Every record of `userId`, by community. A missing, unreadable or malformed entry reads as none. */
function readAll(userId: string): Records {
  let raw: string | null;
  try {
    raw = localStorage.getItem(keyFor(userId));
  } catch (error) {
    console.warn(`[GRAINE] the answered history asks could not be read: ${String(error)}`);
    return {};
  }
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Records) : {};
  } catch (error) {
    console.warn(
      `[GRAINE] the answered history asks are not valid JSON - read as none: ${String(error)}`
    );
    return {};
  }
}

function writeAll(userId: string, records: Records): void {
  try {
    if (Object.keys(records).length === 0) localStorage.removeItem(keyFor(userId));
    else localStorage.setItem(keyFor(userId), JSON.stringify(records));
  } catch (error) {
    // Lost, and said: the cost is one more ask at the next start, never a past withheld.
    console.warn(`[GRAINE] the answered history asks could not be written: ${String(error)}`);
  }
}

/**
 * True when the history of `workspaceId` was answered "I hold nothing" at exactly this key group
 * and this epoch - the one case in which asking again would ask the same question of the same
 * roster.
 */
export function historyHeldNothingAt(
  userId: string,
  workspaceId: string,
  groupId: string,
  epoch: number
): boolean {
  const record = readAll(userId)[workspaceId];
  return record?.groupId === groupId && record.epoch === epoch;
}

/** Records that the history ask of `workspaceId`, sealed at `at`, was answered "I hold nothing". */
export function recordHistoryHeldNothing(
  userId: string,
  workspaceId: string,
  at: HistoryHeldNothing
): void {
  const records = readAll(userId);
  records[workspaceId] = { groupId: at.groupId, epoch: at.epoch };
  writeAll(userId, records);
}

/**
 * Forgets the record of `workspaceId`: the community left this device, or its key group was
 * re-joined, and in both cases what was answered before is no longer evidence about its past.
 */
export function forgetHistoryHeldNothing(userId: string, workspaceId: string): void {
  const records = readAll(userId);
  if (!(workspaceId in records)) return;
  delete records[workspaceId];
  writeAll(userId, records);
}
