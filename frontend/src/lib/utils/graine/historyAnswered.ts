/**
 * THE HISTORY ASKS ANSWERED "I HOLD NOTHING", durably (channel-encryption section 24).
 *
 * A device that holds no seed of a community asks one member for its past at every start
 * (`requestCommunityHistory`). An answerer holding nothing used to answer by silence, so the
 * requester had nothing to record and asked again at every launch, for ever - eight sealed
 * requests and eight roster reads per launch on the Mi 9T, 2026-10-15. The answer is now explicit
 * (`GraineBundleMsg.holds_nothing`), and THIS is where it is kept.
 *
 * **What a record answers, and only that:** "at this key group and this distribution epoch, THESE
 * members, each asked in turn, said they hold nothing of this community's past". It is keyed on
 * the ANSWERER, not on the roster: only ONE member is asked at a time (the lowest id with a device
 * online), so one "nothing" says nothing about the others. The election skips the members recorded
 * here and asks the next one; the ask is final only when no eligible member is left unrecorded.
 * The epoch is the version of the roster (every membership change commits to the key group), so a
 * record whose epoch the group has left answers nothing and the next start asks again from the
 * lowest member - the same version `historyUnanswerableAt` keys "nobody to ask" on. No clock is
 * involved anywhere.
 *
 * In `localStorage` per account, like `sendRatchetLedger`: a few bytes, read synchronously, and
 * it survives a restart, which is the whole point. A storage that refuses the read is logged and
 * read as no record, which ASKS - the reading that costs a request rather than a past.
 */

const KEY_PREFIX = 'canari_graine_history_held_nothing:v1:';

/** Where a history ask was answered "I hold nothing": the key group, and the epoch it was sealed at. */
export interface HistoryAskVersion {
  groupId: string;
  epoch: number;
}

/** One community's record: the roster version, and who answered "I hold nothing" at it. */
interface HistoryHeldNothing extends HistoryAskVersion {
  /** Lower-cased user ids, each of whom answered "I hold nothing" at exactly this version. */
  answerers: string[];
  /**
   * Every member of the roster at this version (this user included when another of its devices is
   * on the group) is among `answerers`. Durable for the version because the roster IS the version:
   * nobody can join or leave the key group without moving its epoch.
   */
  final?: boolean;
}

type Records = Record<string, HistoryHeldNothing>;

/** The `localStorage` key holding `userId`'s records - exported so an account wipe can name it. */
export function historyHeldNothingStorageKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

function isRecord(value: unknown): value is HistoryHeldNothing {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<HistoryHeldNothing>;
  return (
    typeof r.groupId === 'string' &&
    typeof r.epoch === 'number' &&
    Array.isArray(r.answerers) &&
    r.answerers.every((a) => typeof a === 'string') &&
    (r.final === undefined || typeof r.final === 'boolean')
  );
}

/** Every well-formed record of `userId`, by community. Anything else reads as none, out loud. */
function readAll(userId: string): Records {
  let raw: string | null;
  try {
    raw = localStorage.getItem(historyHeldNothingStorageKey(userId));
  } catch (error) {
    console.warn(`[GRAINE] the answered history asks could not be read: ${String(error)}`);
    return {};
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(
      `[GRAINE] the answered history asks are not valid JSON - read as none: ${String(error)}`
    );
    return {};
  }
  if (!parsed || typeof parsed !== 'object') {
    console.warn('[GRAINE] the answered history asks are not an object - read as none');
    return {};
  }
  const records: Records = {};
  for (const [workspaceId, value] of Object.entries(parsed)) {
    if (isRecord(value)) records[workspaceId] = value;
    else
      console.warn(
        `[GRAINE] the answered history ask of community ${workspaceId.slice(0, 8)} is malformed - read as none`
      );
  }
  return records;
}

function writeAll(userId: string, records: Records): void {
  try {
    if (Object.keys(records).length === 0)
      localStorage.removeItem(historyHeldNothingStorageKey(userId));
    else localStorage.setItem(historyHeldNothingStorageKey(userId), JSON.stringify(records));
  } catch (error) {
    // Lost, and said: the cost is one more ask at the next start, never a past withheld.
    console.warn(`[GRAINE] the answered history asks could not be written: ${String(error)}`);
  }
}

/**
 * The members (lower-cased) who answered "I hold nothing" for the history of `workspaceId` at
 * exactly this key group and epoch. Empty when the record names another version - a moved roster,
 * where every member is worth asking again.
 */
export function historyHeldNothingBy(
  userId: string,
  workspaceId: string,
  at: HistoryAskVersion
): Set<string> {
  const record = readAll(userId)[workspaceId];
  if (!record || record.groupId !== at.groupId || record.epoch !== at.epoch) return new Set();
  return new Set(record.answerers);
}

/**
 * Records that `answerer` answered the history ask of `workspaceId`, sealed at `at`, with "I hold
 * nothing". A record of another version is REPLACED, not merged: its answers were about a roster
 * the group has left.
 */
export function recordHistoryHeldNothing(
  userId: string,
  workspaceId: string,
  at: HistoryAskVersion,
  answerer: string
): void {
  const records = readAll(userId);
  const previous = records[workspaceId];
  const sameVersion =
    previous !== undefined && previous.groupId === at.groupId && previous.epoch === at.epoch;
  const answerers = new Set(sameVersion ? previous.answerers : []);
  answerers.add(answerer.toLowerCase());
  records[workspaceId] = { groupId: at.groupId, epoch: at.epoch, answerers: [...answerers].sort() };
  writeAll(userId, records);
}

/**
 * True when EVERY eligible member was asked at this version and answered "I hold nothing" - the one
 * state in which a start skips even the roster read, because the roster cannot have changed.
 */
export function historyHeldNothingFinalAt(
  userId: string,
  workspaceId: string,
  at: HistoryAskVersion
): boolean {
  const record = readAll(userId)[workspaceId];
  return record?.groupId === at.groupId && record.epoch === at.epoch && record.final === true;
}

/**
 * Marks the record of `workspaceId` at `at` final: the election found no eligible member left
 * unrecorded. A record of another version (or none) is left alone and said - there is nothing at
 * this version to finalise.
 */
export function markHistoryHeldNothingFinal(
  userId: string,
  workspaceId: string,
  at: HistoryAskVersion
): void {
  const records = readAll(userId);
  const record = records[workspaceId];
  if (!record || record.groupId !== at.groupId || record.epoch !== at.epoch) {
    console.debug(
      `[GRAINE] no "I hold nothing" record of community ${workspaceId.slice(0, 8)} at epoch ${at.epoch} to mark final`
    );
    return;
  }
  record.final = true;
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

/**
 * Removes EVERY record of `userId` - for the account wipe (WP-DEL-LOCAL), after which nobody can
 * sign in as that account again on this install and its records are only a residue.
 */
export function clearHistoryHeldNothing(userId: string): void {
  try {
    localStorage.removeItem(historyHeldNothingStorageKey(userId));
    console.debug(`[GRAINE] the answered history asks of ${userId.slice(0, 8)} are removed`);
  } catch (error) {
    console.warn(`[GRAINE] the answered history asks could not be removed: ${String(error)}`);
  }
}
