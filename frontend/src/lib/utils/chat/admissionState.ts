import type { IMlsService, UserGroupRow } from '$lib/mls-client/IMlsService';
import type { Conversation } from '$lib/types';
import { isChannelConversationId } from './channelCrypto';
import { readLocalMembership } from './eviction';
import { dropGroupState, type DroppableMlsService } from './dropGroupState';
import { persistMlsStructuralCheckpoint } from '$lib/mls-client/mlsStatePersisterRegistry';

/**
 * Whether a conversation row is NEVER-ADMITTED: this account followed an invitation link, the server
 * holds its seat as an ask no member has answered (`awaitingAdmission`), and this device was never in
 * the group (`pending`). Nothing in it was ever readable here, so it is neither an established
 * channel nor a conversation with a past to keep.
 *
 * `pending` is part of the fact, not a filter on it: a row that was ever `active` was admitted, and
 * the two demotions out of `active` clear the flag as they write `pending`.
 */
export function isNeverAdmitted(
  convo: Pick<Conversation, 'lifecycle' | 'awaitingAdmission'>
): boolean {
  return convo.awaitingAdmission === true && convo.lifecycle === 'pending';
}

/**
 * Brings each conversation row's `awaitingAdmission` to what the server's list says of the ACCOUNT's
 * seat (`UserGroupRow.awaitingAdmission`), the one writer of the flag outside the demotions.
 *
 * The ask is the person's, not the device's (review of #2442): the list says it whether or not this
 * device holds a device row there, so a joiner's second device - no row yet - reads its conversation
 * as waiting for a member like the first, never as an ordinary `pending` one. A row the server says
 * nothing about is left as it is: "the server did not say" is not "not an ask". An `active` row is
 * never flagged: this device is in the group, so the person was admitted.
 *
 * AN OLDER SERVER says the flag only on this device's seat (`deviceMembership.awaitingAdmission`), so
 * that is read when the row carries no account-seat flag - a shim while a store build runs ahead of
 * production (`docs/wiki/legacy-compatibility.md`), logged at
 * WARN once per pass because reaching it means the server is older than this client.
 *
 * @param log where the fallback is said; one line per pass, naming how many rows took it.
 * @returns the keys whose flag changed, for the caller to persist.
 */
export function syncAdmissionFlags(
  conversations: Map<string, Conversation>,
  serverGroups: readonly UserGroupRow[],
  log?: (message: string) => void
): string[] {
  const changed: string[] = [];
  let fromDeviceSeat = 0;
  for (const g of serverGroups) {
    const convo = conversations.get(g.groupId);
    if (g.awaitingAdmission === undefined && g.deviceMembership?.awaitingAdmission !== undefined) {
      fromDeviceSeat++;
    }
    const said = g.awaitingAdmission ?? g.deviceMembership?.awaitingAdmission;
    if (!convo || said === undefined) continue;
    const awaiting = said === true && convo.lifecycle !== 'active';
    if ((convo.awaitingAdmission === true) === awaiting) continue;
    conversations.set(g.groupId, { ...convo, awaitingAdmission: awaiting });
    changed.push(g.groupId);
  }
  if (fromDeviceSeat > 0) {
    log?.(
      `[DISCOVERY] [WARN] the groups list carries no account-seat awaitingAdmission on ${fromDeviceSeat} row(s) - ` +
        `read off this device's seat instead (a server older than this client)`
    );
  }
  return changed;
}

/**
 * Brings each restored conversation row's lifecycle to the MLS state the restore actually holds -
 * in memory only; the caller persists the keys it is given back.
 *
 * - an `active` row whose group is NOT held is demoted to `pending` (`demoted`): it cannot send, and
 *   the next connection asks for its re-admission. Admitted once, so never read as a never-admitted
 *   ask again;
 * - a `pending` row whose group IS held, and whose MEMBERSHIP reads `true`, is promoted to `active`
 *   (`promoted`): its "Sync" badge would otherwise stay for ever (DF5);
 * - a row - `active` OR `pending` - whose group is held but whose membership reads `false` is
 *   `pending`, and the evicted state under it is DROPPED (`awaiting`): the recovery then asks the
 *   server, whose answer ends it.
 *
 * AN `active` ROW OVER A GROUP THIS DEVICE IS OUT OF IS A PAIR NOTHING LOCAL CAN INTERPRET (review of
 * #2808). It is what a kill leaves between a merged Remove becoming durable and the row's own write -
 * two stores, and a checkpoint takes no lock against the commit path: a flush on backgrounding, a
 * structural checkpoint of another group, or one already running can each export the merged Remove
 * before the row is saved, whatever order the commit path issues its own writes in. The Remove may
 * be a real eviction or the first half of this device's own re-admission, and the in-memory record
 * that told them apart (`reAddIsInFlight`) died with the process. Kept `active`, the next send
 * recorded an eviction and retired a conversation the Welcome was about to give back; so the
 * restore no longer decides at all. The server does: a Welcome owed is waited for, a seat is joined,
 * NO seat retires the row (`stopRecovering`) - the right end for both readings of the Remove.
 *
 * WHY THE PROMOTION READS MEMBERSHIP AND NOT `getLocalGroups()` ALONE. An evicted
 * group stays held, and a `pending` row over a held group this device is out of is a re-admission
 * waiting for its Welcome - written by the client before 2026-10-31, which kept the evicted state
 * (`retireIfEvicted` now drops it). Promoted on held state, it became `active` over a group nothing
 * can be sent into, and the outbox then failed the next message as evicted and retired the
 * conversation the Welcome was about to give back (review, 2026-10-31). Kept as it was, nothing
 * would ever end the wait: `requestReAdd` and the watchdog both read a held group as needing nothing.
 * Dropped, it is the ordinary awaiting-Welcome state, which the recovery ends on the server's answer.
 * An unreadable membership (`null`) promotes and drops nothing; `readLocalMembership` logs it.
 */
export async function reconcileRestoredLifecycles(deps: {
  conversations: Map<string, Conversation>;
  localGroups: ReadonlySet<string>;
  mlsService: Pick<IMlsService, 'isGroupActive'> & DroppableMlsService;
  log: (message: string) => void;
}): Promise<{ demoted: string[]; promoted: string[]; awaiting: string[] }> {
  const { conversations, localGroups, mlsService, log } = deps;
  const demoted: string[] = [];
  const promoted: string[] = [];
  const awaiting: string[] = [];
  /** Rows over a held group, whose membership decides them. */
  const held: Array<{ key: string; groupId: string }> = [];
  for (const [key, c] of conversations.entries()) {
    if (isChannelConversationId(c.id)) continue;
    if (c.lifecycle === 'active' && !localGroups.has(c.id)) {
      conversations.set(key, { ...c, lifecycle: 'pending', awaitingAdmission: false });
      demoted.push(key);
    } else if (c.lifecycle !== 'removed' && localGroups.has(c.id)) {
      held.push({ key, groupId: c.id });
    }
  }
  const memberships = await readMemberships(
    held.map(({ groupId }) => groupId),
    mlsService,
    log
  );
  let dropped = 0;
  for (const [i, { key, groupId }] of held.entries()) {
    const member = memberships[i];
    if (member === false) {
      const was = conversations.get(key)?.lifecycle;
      // NO CHECKPOINT PER ROW: each is a full encrypted save (~1.7 s on a phone), and this runs
      // before the connection opens. ONE checkpoint below covers every drop of the pass.
      await dropGroupState(mlsService, groupId, {
        reason: `a restored ${was ?? 'missing'} row over a group this device is out of - the server decides`,
        checkpoint: 'never-persisted',
        log,
      });
      dropped += 1;
      // Re-read: the await above lets another writer touch the row.
      const now = conversations.get(key);
      if (now && now.lifecycle !== 'removed') {
        // An `active` row was admitted once, so it is never read as a never-admitted ask again.
        if (now.lifecycle === 'active') {
          conversations.set(key, { ...now, lifecycle: 'pending', awaitingAdmission: false });
        }
        awaiting.push(key);
      }
      continue;
    }
    if (member !== true) continue;
    const now = conversations.get(key);
    if (now?.lifecycle !== 'pending') continue;
    conversations.set(key, { ...now, lifecycle: 'active' });
    promoted.push(key);
  }
  if (dropped > 0) {
    // Not under the MLS mutex, and the session is not open yet: awaited, so the drops are durable
    // before the restore's verdict on the rows is written.
    try {
      await persistMlsStructuralCheckpoint({ mlsService });
    } catch (e) {
      log(`[INIT] checkpoint after dropping ${dropped} evicted state(s) FAILED: ${String(e)}`);
    }
  }
  return { demoted, promoted, awaiting };
}

/**
 * The restore's verdict on the rows, made DURABLE: {@link reconcileRestoredLifecycles}, then a write
 * of every row it changed. Without the write a demotion lived in memory only, and the next boot read
 * the stored `active` row again - over a group whose evicted state it had already dropped.
 */
export async function applyRestoredLifecycles(deps: {
  conversations: Map<string, Conversation>;
  localGroups: ReadonlySet<string>;
  mlsService: Pick<IMlsService, 'isGroupActive'> & DroppableMlsService;
  saveConversation: (key: string) => Promise<void>;
  log: (message: string) => void;
}): Promise<{ demoted: string[]; promoted: string[]; awaiting: string[] }> {
  const { saveConversation, log } = deps;
  const out = await reconcileRestoredLifecycles(deps);
  const save = (keys: readonly string[], what: string) =>
    Promise.all(
      keys.map((key) =>
        saveConversation(key).catch((e: unknown) =>
          log(`[INIT] ${key.slice(0, 8)}... ${what} row not saved: ${String(e)}`)
        )
      )
    );
  if (out.awaiting.length > 0) {
    log(
      `[INIT] ${out.awaiting.length} conversation(s) hold a group this device is out of - evicted state dropped, pending until the server answers the recovery: ${out.awaiting.map((k) => k.slice(0, 8)).join(', ')}`
    );
    await save(out.awaiting, 'pending');
  }
  if (out.demoted.length > 0) {
    log(
      `[WARN] Groups without local MLS state detected - ${out.demoted.length} conversation(s) marked not-ready, re-invite triggered on next connect.`
    );
    console.warn(
      `[INIT] ${out.demoted.length} conversation(s) missing local MLS state - marked not-ready`
    );
    await save(out.demoted, 'demoted');
  }
  if (out.promoted.length > 0) {
    log(
      `[INIT] ${out.promoted.length} conversation(s) stuck pending but already synced - "Sync" badge cleared.`
    );
    await save(out.promoted, 'promoted');
  }
  return out;
}

/** How many membership reads the restore runs at once - each is one IPC call on native. */
const RESTORE_MEMBERSHIP_READS_IN_FLIGHT = 8;

/**
 * Reads the local membership of every group in `groupIds`, in order, at most
 * {@link RESTORE_MEMBERSHIP_READS_IN_FLIGHT} at a time. An unreadable one is `null`, as
 * `readLocalMembership` answers (and logs) it.
 */
async function readMemberships(
  groupIds: readonly string[],
  mlsService: Pick<IMlsService, 'isGroupActive'>,
  log: (message: string) => void
): Promise<Array<boolean | null>> {
  const out: Array<boolean | null> = Array.from({ length: groupIds.length }, () => null);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < groupIds.length) {
      const i = next++;
      out[i] = await readLocalMembership({
        mlsService,
        groupId: groupIds[i],
        context: 'while reconciling a restored row',
        log,
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(RESTORE_MEMBERSHIP_READS_IN_FLIGHT, groupIds.length) }, worker)
  );
  return out;
}
