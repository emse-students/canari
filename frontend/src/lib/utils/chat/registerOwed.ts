/**
 * THE NICKNAME REGISTER A NEWCOMER IS STILL OWED, ASKED FOR UNTIL IT ARRIVES - OR UNTIL A BOUNDED
 * NUMBER OF ASKS HAS BROUGHT NOTHING (docs/wiki/protocols/history-answer-addressing.md, "The newcomer
 * asks for its register").
 *
 * A device admitted to a group conversation used to get the conversation's state - the nickname
 * register among it - only from the inviter's join push, which is an addressed transport frame: a
 * newcomer offline when its Welcome was delivered got none, and nothing retried. So the newcomer
 * ASKS: processing a Welcome writes a durable "register owed" marker for the group, every
 * reconciliation of that group then asks with a DIGEST carrying `register: true` (the state key's
 * match is answered by silence, which would never deliver it), the elected responder answers with
 * the register, sealed to the ask's key, and the first register actually TAKEN - from that answer or
 * from an accepted join push - clears the marker.
 *
 * **IT TERMINATES ON A COUNT, NOT A CLOCK.** Every register ask sent is counted here, durably; after
 * {@link REGISTER_ASKS_MAX} asks the marker is dropped (said at warn). Without that, a group whose
 * members all run a build that ignores `register` - or that the server cannot address - would send the
 * full digest instead of the state key on every connection until the FIFO pushed the group out.
 * Counted at the ASK rather than at an answer because silence is an answer: an older responder whose
 * store matches ours sends nothing at all, so no answer-side count would ever move.
 *
 * Durable (`localStorage`, per account) because the question outlives the page: a reload between
 * the Welcome and the answer must still ask. Bounded ({@link REGISTER_OWED_LIMIT}) as a FIFO - state,
 * never a clock; a group pushed out is one whose register the next Welcome to it re-opens.
 */
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

/** How many conversations may owe their register at once - far above the joins of one absence. */
export const REGISTER_OWED_LIMIT = 256;

/**
 * How many register asks a group may send before the marker is dropped. Each ask leaves on a state
 * edge (a connection, a fresh join, a member coming back), and a responder on this build answers the
 * first one it is elected for; five is several connections' worth of elections that found none.
 */
export const REGISTER_ASKS_MAX = 5;

/** One owed register: the group, and how many asks for it have left so far. */
type Owed = { group: string; asked: number };

function read(account: string): Owed[] {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY.registerOwed(account.toLowerCase()));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(
          (o): o is Owed =>
            typeof o === 'object' &&
            o !== null &&
            typeof (o as Owed).group === 'string' &&
            Number.isInteger((o as Owed).asked)
        )
      : [];
  } catch (e) {
    console.error(
      `[REGISTER] owed register list unreadable - read as empty: ${String(e).slice(0, 120)}`
    );
    return [];
  }
}

/** Writes the list; `false` (said at error) when the store refused it. */
function write(account: string, owed: Owed[]): boolean {
  try {
    localStorage.setItem(
      ACCOUNT_KEY.registerOwed(account.toLowerCase()),
      JSON.stringify(owed.slice(-REGISTER_OWED_LIMIT))
    );
    return true;
  } catch (e) {
    console.error(`[REGISTER] owed register list not written: ${String(e).slice(0, 120)}`);
    return false;
  }
}

/** Records that `account`, just admitted to `groupId`, is owed its register - asked from zero. */
export function noteRegisterOwed(account: string, groupId: string): void {
  const owed = read(account).filter((o) => o.group !== groupId);
  owed.push({ group: groupId, asked: 0 });
  if (!write(account, owed)) return;
  console.log(
    `[REGISTER] ${groupId.slice(0, 8)}... owes its register - the next reconciliation asks for it`
  );
}

/** Whether `account` still asks for `groupId`'s register. */
export function isRegisterOwed(account: string, groupId: string): boolean {
  return read(account).some((o) => o.group === groupId);
}

/**
 * Counts one register ask SENT for `groupId`; the ask that reaches {@link REGISTER_ASKS_MAX} is the
 * last, and the marker is dropped with it (said at warn: no responder on a build that answers
 * `register` was elected that many times).
 */
export function noteRegisterAsked(account: string, groupId: string): void {
  const owed = read(account);
  const entry = owed.find((o) => o.group === groupId);
  if (!entry) return;
  entry.asked += 1;
  if (entry.asked < REGISTER_ASKS_MAX) {
    write(account, owed);
    return;
  }
  if (
    !write(
      account,
      owed.filter((o) => o.group !== groupId)
    )
  ) {
    return;
  }
  console.warn(
    `[REGISTER] ${groupId.slice(0, 8)}... asked for its register ${entry.asked} time(s) and took none - no longer asked (its members do not answer \`register\`, or cannot be addressed)`
  );
}

/** The register was TAKEN (a register answer or the inviter's push merged it): stop asking. */
export function clearRegisterOwed(account: string, groupId: string, how: string): void {
  const owed = read(account);
  if (!owed.some((o) => o.group === groupId)) return;
  if (
    !write(
      account,
      owed.filter((o) => o.group !== groupId)
    )
  ) {
    return;
  }
  console.log(`[REGISTER] ${groupId.slice(0, 8)}... register received (${how}) - no longer asked`);
}
