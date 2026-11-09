/**
 * THE INVITER'S JOIN PUSH, HUNG ON THE DELIVERY OF A WELCOME - never on one caller of it.
 *
 * A device admitted to a group conversation gets the conversation's STATE from the member that
 * welcomed it: the nickname register above all, which is the ONE bundle a reader takes a register
 * from (`mergeBundleNicknames`), and the pins, the floor and the read watermarks beside it. That push
 * used to be sent by two callers (the pending invitation and the welcome_request answer) and not by
 * the member's "Ajouter", nor by the owed-Welcome drain that delivers a Welcome whose first send
 * failed or whose Add's commit was settled later - so a newcomer admitted there never learned a
 * nickname set before them (2026-11-09). `BaseMlsService` now announces every Welcome the server
 * stored, whoever sent it (`onWelcomeDelivered`), and this module answers each with one push.
 *
 * - **Exactly once per delivered Welcome, from durable state.** A per-account ledger remembers the
 *   Welcomes already pushed for (group, device, fingerprint of the bytes). The drain consumes what it
 *   delivers, so a re-run sends nothing; a reload that lost the clear re-sends the same bytes, and the
 *   ledger - written before the push starts - keeps that second delivery from pushing again (the
 *   joiner, holding the group already, would refuse the push as answering no ask). A later Welcome to
 *   the same device (a re-add) has other bytes, and is pushed for.
 * - **Never the past.** The push is `sendFullHistoryBundle`: addressed to the device and filtered on
 *   its owner's server windows (step A), so a newcomer receives no message from before their arrival.
 * - **Never awaited by the gesture.** Started on the delivery, synchronously queued, run one at a time
 *   (each decrypts the whole store), each caught and said on its own.
 * - **Not for a key group.** A community's Graine key group carries no conversation and no history.
 */
import type { IStorage } from '$lib/db';
import type { DeliveredWelcome } from '$lib/mls-client/IMlsService';
import type { IMlsService } from '$lib/mlsService';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { sendFullHistoryBundle } from './groupActions';
import { digestIdentity } from './historyDigestRendezvous';

/** How many pushed Welcomes the ledger remembers - a bounded FIFO, state and never a clock. */
export const JOIN_PUSH_LEDGER_SIZE = 512;

/** What a push needs, read at the moment it runs: the session may have moved since the install. */
export type JoinPushDeps = {
  account: () => string;
  storage: () => IStorage | null;
  deviceKeyB64: () => string;
  log: (msg: string) => void;
};

/** FNV-1a over the Welcome's bytes, with its length: tells one Welcome to a device from the next. */
function fingerprint(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${bytes.length.toString(36)}.${h.toString(36)}`;
}

function ledgerKey(d: DeliveredWelcome): string {
  return `${d.groupId}|${d.userId.toLowerCase()}:${d.deviceId}|${fingerprint(d.welcome)}`;
}

function readLedger(account: string): string[] {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY.joinPushesSent(account));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : [];
  } catch (e) {
    console.error(`[JOIN_PUSH] ledger unreadable - read as empty: ${String(e).slice(0, 120)}`);
    return [];
  }
}

/**
 * Claims the push owed for `delivered`: `true` when none was claimed before (and records it), `false`
 * when this Welcome was pushed for already. A ledger that cannot be written still pushes - once in
 * this session, said at error, since what is lost is only the guard against a reload's re-send.
 */
function claim(account: string, delivered: DeliveredWelcome): boolean {
  const key = ledgerKey(delivered);
  const ledger = readLedger(account);
  if (ledger.includes(key)) return false;
  ledger.push(key);
  try {
    localStorage.setItem(
      ACCOUNT_KEY.joinPushesSent(account),
      JSON.stringify(ledger.slice(-JOIN_PUSH_LEDGER_SIZE))
    );
  } catch (e) {
    console.error(
      `[JOIN_PUSH] ledger not written for ${delivered.deviceId} in ${delivered.groupId.slice(0, 8)}... - pushing anyway, a reload's re-send would push again: ${String(e).slice(0, 120)}`
    );
  }
  return true;
}

/** The pushes started and not yet done, in order - one at a time. */
let queue: Promise<void> = Promise.resolve();

/**
 * The push owed for one delivered Welcome. Resolves when it is done; never throws - every branch that
 * sends nothing says why.
 */
export async function pushForDeliveredWelcome(
  mls: IMlsService,
  delivered: DeliveredWelcome,
  deps: JoinPushDeps
): Promise<void> {
  const { groupId, userId, deviceId } = delivered;
  const short = groupId.slice(0, 8);
  if (mls.isDistributionGroup(groupId)) {
    deps.log(`[JOIN_PUSH] ${short}... is a key group - no join push to ${deviceId}`);
    return;
  }
  const account = deps.account();
  if (!account) {
    console.error(
      `[JOIN_PUSH] ${short}... Welcome delivered to ${deviceId} with no signed-in account - no join push`
    );
    return;
  }
  if (!claim(account, delivered)) {
    deps.log(
      `[JOIN_PUSH] ${short}... this Welcome to ${userId}:${deviceId} was pushed for already - not again`
    );
    return;
  }
  deps.log(`[JOIN_PUSH] ${short}... join push -> ${userId}:${deviceId}`);
  try {
    await sendFullHistoryBundle(groupId, {
      storage: deps.storage(),
      deviceKeyB64: deps.deviceKeyB64(),
      mlsService: mls,
      log: deps.log,
      to: digestIdentity(userId, deviceId),
    });
  } catch (e) {
    console.error(
      `[JOIN_PUSH] ${short}... the join push to ${userId}:${deviceId} failed: ${String(e).slice(0, 120)}`
    );
  }
}

/**
 * Queues the push owed for `delivered` behind the ones already started, and returns the promise of
 * this one (the tests await it; the delivery never does).
 */
export function queueJoinPush(
  mls: IMlsService,
  delivered: DeliveredWelcome,
  deps: JoinPushDeps
): Promise<void> {
  const run = queue.then(() => pushForDeliveredWelcome(mls, delivered, deps));
  queue = run;
  return run;
}

/** Installs the join push on `mls`: every Welcome it delivers from now on is pushed for. */
export function installJoinPush(mls: IMlsService, deps: JoinPushDeps): void {
  mls.onWelcomeDelivered((delivered) => {
    void queueJoinPush(mls, delivered, deps);
  });
}
