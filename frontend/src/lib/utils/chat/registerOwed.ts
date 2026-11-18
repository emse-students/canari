/**
 * THE NICKNAME REGISTER A NEWCOMER IS STILL OWED - TWO DURABLE FACTS, ONE PER QUESTION
 * (docs/wiki/protocols/history-answer-addressing.md, "The newcomer asks for its register").
 *
 * A device admitted to a group conversation used to get the conversation's state - the nickname
 * register among it - only from the inviter's join push, which is an addressed transport frame: a
 * newcomer offline when its Welcome was delivered got none, and nothing retried. So the newcomer
 * ASKS: processing a Welcome writes a durable entry for the group, every reconciliation of that
 * group then asks with a DIGEST carrying `register: true` (the state key's match is answered by
 * silence, which would never deliver it), the elected responder answers with the register, sealed
 * to the ask's key, and the first register actually TAKEN - from that answer or from an accepted
 * join push - deletes the entry.
 *
 * **THE ENTRY ANSWERS TWO QUESTIONS, AND KEEPS ONE FIELD FOR EACH** (review of #3777, P2-b):
 *
 * - **"was a register ever taken here?"** - the entry's existence ({@link registerNeverTaken}). It
 *   ends ONLY when one is taken. A responder asks it before answering a register ask: a device that
 *   never took one has none to restate, and DECLINES (a typed "none held" answer) rather than
 *   handing over an empty register that would end the asker's entry on nothing;
 * - **"do I still ask?"** - `asking` ({@link isRegisterOwed}). It ends on a PROOF that asking is
 *   useless, never on a clock: {@link REGISTER_ASKS_MAX} asks that brought neither a register nor a
 *   decline (every build at the floor, `1.7.0`, answers or declines `register`, so only a defect or
 *   a server that cannot address reaches it), or a decline from EVERY other device of the group
 *   (nobody holds a register to give). Stopping to ask never makes a device answer as if it held one.
 *
 * **A DEVICE'S FIRST DECLINE IS NOT COUNTED.** Two newcomers - or one person's phone and laptop -
 * elected for each other's asks both decline; counting those would spend the bound on answers that
 * prove only who cannot help. So the FIRST decline from each device gives its ask back, and every
 * later one from the same device is counted like silence (review of #3777, P2-1): giving back on
 * every decline let a device that declines at each election - or a hostile member declining on
 * purpose - keep the count at zero for ever, and let the two answerers of one ask erase an earlier
 * silent ask. The asks are therefore bounded by {@link REGISTER_ASKS_MAX} plus the number of other
 * devices, whatever is online. Counted at the ask rather than at an answer because silence is an
 * answer: a responder that never answers (a defect - every build at the `1.7.0` floor answers or
 * declines `register` - or one the server cannot address) moves no answer-side count.
 *
 * Durable (`localStorage`, per account) because the question outlives the page: a reload between
 * the Welcome and the answer must still ask. Bounded ({@link REGISTER_OWED_LIMIT}) as a FIFO - state,
 * never a clock; a group pushed out is one whose register the next Welcome to it re-opens, and which
 * meanwhile answers others as a holder would.
 */
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

/** How many conversations may owe their register at once - far above the joins of one absence. */
export const REGISTER_OWED_LIMIT = 256;

/**
 * How many register asks that brought neither a register nor a decline a group may send. Each ask
 * leaves on a state edge (a connection, a fresh join, a member coming back), and a responder on this
 * build answers - or declines - the first one it is elected for; five unanswered is several
 * connections' worth of elections that brought no answer - a defect, since every build at the
 * floor (`1.7.0`) answers or declines `register`, or a server that cannot address.
 */
export const REGISTER_ASKS_MAX = 5;

/**
 * One group whose register this account never took: whether it still asks, how many of its asks are
 * still unanswered, and which devices (`user:device`) declined, holding none.
 */
type Owed = { group: string; asked: number; asking: boolean; declined: string[] };

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
            Number.isInteger((o as Owed).asked) &&
            typeof (o as Owed).asking === 'boolean' &&
            Array.isArray((o as Owed).declined)
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
  owed.push({ group: groupId, asked: 0, asking: true, declined: [] });
  if (!write(account, owed)) return;
  console.log(
    `[REGISTER] ${groupId.slice(0, 8)}... owes its register - the next reconciliation asks for it`
  );
}

/** Whether `account` still ASKS for `groupId`'s register. */
export function isRegisterOwed(account: string, groupId: string): boolean {
  return read(account).some((o) => o.group === groupId && o.asking);
}

/**
 * Whether `account` never TOOK `groupId`'s register since its admission - asking or not. A device
 * for which this holds has no register to restate, and declines a register ask.
 */
export function registerNeverTaken(account: string, groupId: string): boolean {
  return read(account).some((o) => o.group === groupId);
}

/** Counts one register ask that LEFT for `groupId`. */
export function noteRegisterAsked(account: string, groupId: string): void {
  const owed = read(account);
  const entry = owed.find((o) => o.group === groupId && o.asking);
  if (!entry) return;
  entry.asked += 1;
  write(account, owed);
}

/**
 * Ends the asking when {@link REGISTER_ASKS_MAX} asks went unanswered - called before an ask, so a
 * decline that came back meanwhile has already given its ask back. Said at ERROR: every build at the
 * floor (`1.7.0`) answers or declines `register`, so only a defect - or a server that cannot address -
 * reaches it (docs/wiki/legacy-compatibility.md history). The entry stays: the register is still
 * not taken.
 *
 * @returns whether the asking is over (nothing is to be asked).
 */
export function endSpentRegisterAsks(account: string, groupId: string): boolean {
  const owed = read(account);
  const entry = owed.find((o) => o.group === groupId && o.asking);
  if (!entry || entry.asked < REGISTER_ASKS_MAX) return false;
  entry.asking = false;
  if (!write(account, owed)) return true;
  console.error(
    `[REGISTER] ${groupId.slice(0, 8)}... asked for its register ${entry.asked} time(s) with no answer - no longer asked (every member at the floor answers \`register\`, so this is a defect, or they cannot be addressed)`
  );
  return true;
}

/**
 * An elected device DECLINED a register ask for `groupId`: it holds none. The ask is given back
 * (a decline proves who cannot help, not that nobody can), and the decliner remembered; once every
 * device in `others` - the group's devices but this one - has declined, nobody holds a register to
 * give and the asking ends, said at warn. The entry stays: the register is still not taken.
 */
export function noteRegisterDeclined(
  account: string,
  groupId: string,
  decliner: string,
  others: readonly string[]
): void {
  const owed = read(account);
  const entry = owed.find((o) => o.group === groupId && o.asking);
  if (!entry) return;
  // ONLY A FIRST DECLINE GIVES ITS ASK BACK: one ask per device at most, which is what bounds the
  // asks by REGISTER_ASKS_MAX plus the other devices, however often a device declines.
  const first = !entry.declined.includes(decliner);
  if (first) {
    entry.declined.push(decliner);
    entry.asked = Math.max(0, entry.asked - 1);
  }
  const nobodyHolds = others.length > 0 && others.every((d) => entry.declined.includes(d));
  if (nobodyHolds) entry.asking = false;
  if (!write(account, owed)) return;
  if (nobodyHolds) {
    console.warn(
      `[REGISTER] ${groupId.slice(0, 8)}... every other device (${others.length}) declined - none holds a register, no longer asked`
    );
  } else {
    console.log(
      `[REGISTER] ${groupId.slice(0, 8)}... ${decliner.slice(0, 8)} holds no register - ${first ? 'its first decline: the ask is not counted' : 'declined before: the ask is counted'}`
    );
  }
}

/** The register was TAKEN (a register answer or the inviter's push merged it): both facts end. */
export function clearRegisterOwed(account: string, groupId: string, how: string): void {
  const owed = read(account);
  if (!owed.some((o) => o.group === groupId)) return;
  if (
    !write(
      account,
      owed.filter((o) => o.group !== groupId)
    )
  )
    return;
  console.log(`[REGISTER] ${groupId.slice(0, 8)}... register received (${how}) - no longer asked`);
}
