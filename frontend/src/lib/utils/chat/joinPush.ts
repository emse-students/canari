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
 * - **For the session that delivered it.** The account, the store and the device key are read when
 *   the delivery is ANNOUNCED, and the job is dropped at its turn if the service that delivered it is
 *   no longer the session's client: a push queued before an account switch never runs with the next
 *   account's data through the previous account's MLS client (the queue is module-level).
 *
 * **ONLINE ONLY, AND SAID SO.** The push is an addressed frame, and an addressed frame is
 * transport-only: the server refuses it for a device that is not connected when it leaves
 * (`addressed_unsupported`). A newcomer offline at the delivery of its Welcome therefore receives no
 * push, and nothing here retries it - the ledger entry is written before the push starts. That outcome
 * is returned by `sendFullHistoryBundle` and reported here at warn (`[JOIN_PUSH] NOT DELIVERED`), so
 * its rate can be counted; the deterministic fix (the newcomer asks for the register on its own
 * reconciliation) is designed in `docs/wiki/backlog.d/p2-an-offline-newcomer-receives-no-join-push.md`.
 */
import type { IStorage } from '$lib/db';
import type { DeliveredWelcome } from '$lib/mls-client/IMlsService';
import type { IMlsService } from '$lib/mlsService';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { sendFullHistoryBundle } from './groupActions';
import { digestIdentity } from './historyDigestRendezvous';

/** How many pushed Welcomes the ledger remembers - a bounded FIFO, state and never a clock. */
export const JOIN_PUSH_LEDGER_SIZE = 512;

/** The session a delivery belongs to, read when the delivery is announced. */
export type JoinPushSession = {
  account: string;
  storage: IStorage | null;
  deviceKeyB64: string;
};

/** What the join push reads from the session that installed it. */
export type JoinPushDeps = {
  /** The signed-in session as it stands NOW - read once, at the announcement of a delivery. */
  session: () => JoinPushSession;
  /**
   * Whether the service the push was installed on is still the session's MLS client - read at the
   * announcement AND when the job's turn comes. False once a sign-out or an account switch retired it.
   */
  isCurrent: () => boolean;
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
 * The push owed for one delivered Welcome, with the session captured at its announcement. Resolves
 * when it is done; never throws - every branch that sends nothing says why.
 */
export async function pushForDeliveredWelcome(
  mls: IMlsService,
  delivered: DeliveredWelcome,
  session: JoinPushSession,
  deps: JoinPushDeps
): Promise<void> {
  const { groupId, userId, deviceId } = delivered;
  const short = groupId.slice(0, 8);
  if (!deps.isCurrent()) {
    deps.log(
      `[JOIN_PUSH] ${short}... the client that delivered the Welcome to ${deviceId} was retired before its turn (a sign-out or an account switch) - no join push`
    );
    return;
  }
  if (mls.isDistributionGroup(groupId)) {
    deps.log(`[JOIN_PUSH] ${short}... is a key group - no join push to ${deviceId}`);
    return;
  }
  const { account, storage, deviceKeyB64 } = session;
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
    const outcome = await sendFullHistoryBundle(groupId, {
      storage,
      deviceKeyB64,
      mlsService: mls,
      log: deps.log,
      to: digestIdentity(userId, deviceId),
    });
    if (outcome === 'unaddressable') {
      // THE KNOWN LIMIT, COUNTED: the device was not connected (or a session of it predates
      // addressed answers), and nothing retries - see the module docstring.
      console.warn(
        `[JOIN_PUSH] ${short}... NOT DELIVERED to ${userId}:${deviceId} - the server could not address it (offline at the push, or an older session); it gets no register until the newcomer-asks step ships`
      );
    }
  } catch (e) {
    console.error(
      `[JOIN_PUSH] ${short}... the join push to ${userId}:${deviceId} failed: ${String(e).slice(0, 120)}`
    );
  }
}

/**
 * Queues the push owed for `delivered` behind the ones already started, and returns the promise of
 * this one (the tests await it; the delivery never does). The session is read HERE, at the
 * announcement - never later, when the job's turn comes and the session may be another account's.
 */
export function queueJoinPush(
  mls: IMlsService,
  delivered: DeliveredWelcome,
  deps: JoinPushDeps
): Promise<void> {
  if (!deps.isCurrent()) {
    deps.log(
      `[JOIN_PUSH] ${delivered.groupId.slice(0, 8)}... Welcome delivered to ${delivered.deviceId} by a retired client - no join push`
    );
    return Promise.resolve();
  }
  const session = deps.session();
  const run = queue.then(() => pushForDeliveredWelcome(mls, delivered, session, deps));
  queue = run;
  return run;
}

/** Installs the join push on `mls`: every Welcome it delivers from now on is pushed for. */
export function installJoinPush(mls: IMlsService, deps: JoinPushDeps): void {
  mls.onWelcomeDelivered((delivered) => {
    void queueJoinPush(mls, delivered, deps);
  });
}
