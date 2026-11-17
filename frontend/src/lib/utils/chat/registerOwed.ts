/**
 * THE CONVERSATION STATE A NEWCOMER IS STILL OWED, ASKED FOR UNTIL IT ARRIVES
 * (docs/wiki/protocols/history-answer-addressing.md, "The newcomer asks for its register").
 *
 * A device admitted to a group conversation used to get the conversation's state - the nickname
 * register, the pins, the floor, the read marks - only from the inviter's join push, which is an
 * addressed transport frame: a newcomer offline when its Welcome was delivered got none, and nothing
 * retried. So the newcomer ASKS: processing a Welcome writes a durable "register owed" marker for the
 * group, every reconciliation of that group then asks with a DIGEST carrying `register: true` (the
 * state key's match is answered by silence, which would never deliver it), the elected responder
 * answers with the state, sealed to the ask's key, and the first accepted answer - or an accepted
 * join push - clears the marker.
 *
 * Durable (`localStorage`, per account) because the question outlives the page: a reload between
 * the Welcome and the answer must still ask. Bounded ({@link REGISTER_OWED_LIMIT}) as a FIFO - state,
 * never a clock; a group pushed out is one whose register the next Welcome to it re-opens.
 */
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

/** How many conversations may owe their register at once - far above the joins of one absence. */
export const REGISTER_OWED_LIMIT = 256;

function read(account: string): string[] {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY.registerOwed(account.toLowerCase()));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === 'string') : [];
  } catch (e) {
    console.error(
      `[REGISTER] owed register list unreadable - read as empty: ${String(e).slice(0, 120)}`
    );
    return [];
  }
}

/** Writes the list; `false` (said at error) when the store refused it. */
function write(account: string, groups: string[]): boolean {
  try {
    localStorage.setItem(
      ACCOUNT_KEY.registerOwed(account.toLowerCase()),
      JSON.stringify(groups.slice(-REGISTER_OWED_LIMIT))
    );
    return true;
  } catch (e) {
    console.error(`[REGISTER] owed register list not written: ${String(e).slice(0, 120)}`);
    return false;
  }
}

/** Records that `account`, just admitted to `groupId`, is owed its conversation state. */
export function noteRegisterOwed(account: string, groupId: string): void {
  const groups = read(account).filter((g) => g !== groupId);
  groups.push(groupId);
  if (!write(account, groups)) return;
  console.log(
    `[REGISTER] ${groupId.slice(0, 8)}... owes its register - the next reconciliation asks for it`
  );
}

/** Whether `account` still asks for `groupId`'s state. */
export function isRegisterOwed(account: string, groupId: string): boolean {
  return read(account).includes(groupId);
}

/** The state arrived (a register answer or the inviter's push was accepted): stop asking. */
export function clearRegisterOwed(account: string, groupId: string, how: string): void {
  const groups = read(account);
  if (!groups.includes(groupId)) return;
  if (
    !write(
      account,
      groups.filter((g) => g !== groupId)
    )
  )
    return;
  console.log(`[REGISTER] ${groupId.slice(0, 8)}... register received (${how}) - no longer asked`);
}
