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
 * DEVICES, each asked, said they hold nothing of this community's past". It is keyed on the
 * answering DEVICE, never on its member: a member's online phone saying "nothing" says nothing
 * about a laptop of the same member that is on the key group, offline, and may hold the past. A
 * member counts as answered only once EVERY device of theirs on the key group's MLS tree is
 * recorded here - the tree, not presence, because presence names only the devices online when the
 * ask went out. The epoch is the version of the tree (every membership change commits to the key
 * group), so a record whose epoch the group has left answers nothing and the next start asks again
 * from the lowest member - the same version `historyUnanswerableAt` keys "nobody to ask" on. No
 * clock is involved anywhere.
 *
 * In `localStorage` per account, like `sendRatchetLedger`: a few bytes, read synchronously, and
 * it survives a restart, which is the whole point. A storage that refuses the read is logged and
 * read as no record, which ASKS - the reading that costs a request rather than a past.
 */

import { ACCOUNT_KEY } from '../accountLocalKeys';
import { forgetWorkspaceRecord } from './workspaceRecords';

/** Where a history ask was answered "I hold nothing": the key group, and the epoch it was sealed at. */
export interface HistoryAskVersion {
  groupId: string;
  epoch: number;
}

/** One community's record: the tree version, and which devices answered "I hold nothing" at it. */
interface HistoryHeldNothing extends HistoryAskVersion {
  /** Each device that answered "I hold nothing" at exactly this version, as {@link answeredDevice}. */
  devices: string[];
  /**
   * Every device on the key group's tree at this version (our own other devices included) is among
   * `devices`. Durable for the version because the tree IS the version: no leaf joins or leaves the
   * key group without moving its epoch.
   */
  final?: boolean;
}

type Records = Record<string, HistoryHeldNothing>;

/** How one answering device is named in a record: its user lower-cased, a colon, its device id. */
export function answeredDevice(user: string, device: string): string {
  return `${user.toLowerCase()}:${device}`;
}

function isRecord(value: unknown): value is HistoryHeldNothing {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<HistoryHeldNothing>;
  return (
    typeof r.groupId === 'string' &&
    typeof r.epoch === 'number' &&
    Array.isArray(r.devices) &&
    r.devices.every((d) => typeof d === 'string') &&
    (r.final === undefined || typeof r.final === 'boolean')
  );
}

/** Every well-formed record of `userId`, by community. Anything else reads as none, out loud. */
function readAll(userId: string): Records {
  let raw: string | null;
  try {
    raw = localStorage.getItem(ACCOUNT_KEY.historyHeldNothing(userId));
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
      localStorage.removeItem(ACCOUNT_KEY.historyHeldNothing(userId));
    else localStorage.setItem(ACCOUNT_KEY.historyHeldNothing(userId), JSON.stringify(records));
  } catch (error) {
    // Lost, and said: the cost is one more ask at the next start, never a past withheld.
    console.warn(`[GRAINE] the answered history asks could not be written: ${String(error)}`);
  }
}

/**
 * The devices ({@link answeredDevice}) that answered "I hold nothing" for the history of
 * `workspaceId` at exactly this key group and epoch. Empty when the record names another version -
 * a moved tree, where every device is worth asking again.
 */
export function historyHeldNothingDevices(
  userId: string,
  workspaceId: string,
  at: HistoryAskVersion
): Set<string> {
  const record = readAll(userId)[workspaceId];
  if (!record || record.groupId !== at.groupId || record.epoch !== at.epoch) return new Set();
  return new Set(record.devices);
}

/**
 * Records that `device` of `answerer` answered the history ask of `workspaceId`, sealed at `at`,
 * with "I hold nothing". A record of another version is REPLACED, not merged: its answers were
 * about a tree the group has left.
 *
 * @returns whether the device was new at this version - the only fact allowed to move the walk on,
 *   so an answer repeated by the same device can never re-ask in a loop.
 */
export function recordHistoryHeldNothing(
  userId: string,
  workspaceId: string,
  at: HistoryAskVersion,
  answerer: string,
  device: string
): boolean {
  const records = readAll(userId);
  const previous = records[workspaceId];
  const sameVersion =
    previous !== undefined && previous.groupId === at.groupId && previous.epoch === at.epoch;
  const devices = new Set(sameVersion ? previous.devices : []);
  const named = answeredDevice(answerer, device);
  if (devices.has(named)) return false;
  devices.add(named);
  records[workspaceId] = { groupId: at.groupId, epoch: at.epoch, devices: [...devices].sort() };
  writeAll(userId, records);
  return true;
}

/**
 * True when EVERY device on the key group's tree was asked at this version and answered "I hold
 * nothing" - the one state in which a start skips even the roster read, because the tree cannot
 * have changed.
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
 * Marks the record of `workspaceId` at `at` final: the election found no device on the tree left
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
  forgetWorkspaceRecord(userId, workspaceId, readAll, writeAll);
}
