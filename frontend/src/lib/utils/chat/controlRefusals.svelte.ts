import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

/**
 * A CONTROL ACTION THE DURABLE QUEUE REFUSED (`OutboxEnqueueError`), AS DATA (WP-CONTROL-NOTICE).
 *
 * The peers will not hear of it, so the message wears a discreet mention with "Retry"
 * (`ControlRefusedNotice`) instead of the refusal living in `console.error` alone.
 *
 * ONE ENTRY PER MESSAGE AND ACT, NEVER ONE PER MESSAGE. A refused 👍 followed by a pin that the queue
 * took must still offer the 👍: the reaction stays applied here and no peer has it, so dropping its
 * refusal is a permanent divergence. The key ({@link controlRefusalKey}) is the message plus the kind,
 * plus the emoji for a reaction: only an act with the SAME key AND NOT OLDER supersedes a refusal (a
 * newer edit, a newer pin state, the same emoji placed or taken back), and a delete clears the
 * message's every one.
 *
 * DURABLE, BECAUSE THE STATE IT DESCRIBES IS. The optimistic reaction, edit and pin are persisted the
 * moment the user acts (`persistLocalMutation`, `applyPin`), so a refusal kept in memory alone would
 * vanish at the next reload or kill and leave the mutation shown locally, unknown to the peers, with
 * nothing left to retry. The refusals live under the account's {@link ACCOUNT_KEY}`.controlRefusals`
 * (an account deletion sweeps it) and carry NO message text: an edit's text is read back from the row
 * at retry time. A retry is DATA run by an executor the chat page registers with a fresh context, so
 * nothing here pins a session, a context or a conversation snapshot.
 *
 * Read-watermark refusals are NOT recorded: they target no message, and the next watermark (or the
 * owed-mark ledger) carries the same information.
 */

/** The user actions that travel as a control event and can be refused by the durable queue. */
export type ControlRefusalKind = 'reaction' | 'edit' | 'pin' | 'delete';

/** What was refused - everything a retry needs except the message text, which the row holds. */
export type ControlAct =
  | { kind: 'reaction'; emoji: string; remove: boolean; at: number }
  | { kind: 'edit'; editedAt: number }
  | { kind: 'pin'; pinned: boolean; at: number }
  | { kind: 'delete' };

/** One refused control action on one message of one conversation (the MLS group id). */
export interface ControlRefusal {
  conversationId: string;
  messageId: string;
  act: ControlAct;
}

/**
 * Runs a refused act again with a context of the moment. Resolves true when the queue took it, false
 * when it refused again; a non-refusal error rejects. Registered by the chat page.
 */
export type ControlRetryExecutor = (refusal: ControlRefusal) => Promise<boolean>;

/** The key a refusal is stored and superseded under: message, kind, and the emoji of a reaction. */
export function controlRefusalKey(messageId: string, act: ControlAct): string {
  return act.kind === 'reaction'
    ? `${messageId}\u0000reaction\u0000${act.emoji}`
    : `${messageId}\u0000${act.kind}`;
}

/**
 * How many refusals one account keeps, oldest evicted first. Bounded because nothing else ages a
 * refusal out: a DM or group row is never swept by age, so a message that leaves the device without
 * a delete would keep its refusal for ever. 100 refused acts never retried is far past any real use.
 */
export const MAX_CONTROL_REFUSALS = 100;

/** The bound account's refusals by {@link controlRefusalKey}, in the order they were refused. */
const refusals = new SvelteMap<string, ControlRefusal>();
const retrying = new SvelteSet<string>();
let boundAccount: string | null = null;
let executor = $state<ControlRetryExecutor | null>(null);

function isAct(v: unknown): v is ControlAct {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  switch (a.kind) {
    case 'reaction':
      return (
        typeof a.emoji === 'string' && typeof a.remove === 'boolean' && typeof a.at === 'number'
      );
    case 'edit':
      return typeof a.editedAt === 'number';
    case 'pin':
      return typeof a.pinned === 'boolean' && typeof a.at === 'number';
    case 'delete':
      return true;
    default:
      return false;
  }
}

function isRefusal(v: unknown): v is ControlRefusal {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.conversationId === 'string' && typeof r.messageId === 'string' && isAct(r.act);
}

/** The instant an act was taken at - what orders two acts under one key. A delete has none. */
function instantOf(act: ControlAct): number {
  switch (act.kind) {
    case 'reaction':
    case 'pin':
      return act.at;
    case 'edit':
      return act.editedAt;
    case 'delete':
      return 0;
  }
}

/** `userId`'s persisted refusals, read from storage (never from memory). */
function readStored(userId: string): ControlRefusal[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(ACCOUNT_KEY.controlRefusals(userId));
  } catch (e) {
    console.error(`[OUTBOX] control refusals unreadable, none shown: ${String(e)}`);
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRefusal) : [];
  } catch (e) {
    console.error(`[OUTBOX] control refusals corrupt, dropped: ${String(e)}`);
    return [];
  }
}

function writeStored(userId: string, list: ControlRefusal[]): void {
  const key = ACCOUNT_KEY.controlRefusals(userId);
  try {
    if (list.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(list));
  } catch (e) {
    // The mention still shows for this session; only its survival across a reload is lost.
    console.error(
      `[OUTBOX] control refusals not persisted (${list.length}), a reload will forget them: ${String(e)}`
    );
  }
}

/**
 * Applies `change` to the refusals of `userId` - THE ACCOUNT THAT ISSUED THE ACT, never whichever is
 * signed in now. Bound to it: memory and storage. Not bound (an act of the previous account settling
 * after a switch): its storage alone, and the store is NEVER rebound, so the account signed in now is
 * never shown the other one's notices.
 */
function changeAccount(userId: string, change: (m: Map<string, ControlRefusal>) => boolean): void {
  if (!userId) return;
  if (boundAccount === userId) {
    if (change(refusals)) writeStored(userId, [...refusals.values()]);
    return;
  }
  console.log('[OUTBOX] control refusal settled for an account not shown now: storage only');
  const m = new Map(readStored(userId).map((r) => [controlRefusalKey(r.messageId, r.act), r]));
  if (change(m)) writeStored(userId, [...m.values()]);
}

/**
 * Binds the store to `userId`, reading its persisted refusals. Called by the chat page for the
 * signed-in account, and by nothing that settles an act (see {@link changeAccount}).
 */
export function loadControlRefusals(userId: string): void {
  if (!userId || boundAccount === userId) return;
  refusals.clear();
  boundAccount = userId;
  const list = readStored(userId);
  for (const r of list) refusals.set(controlRefusalKey(r.messageId, r.act), r);
  if (list.length > 0) console.log(`[OUTBOX] ${list.length} refused control action(s) restored`);
}

/** Records a refusal for `userId`, replacing only an earlier refusal with the same key. */
export function recordControlRefusal(userId: string, refusal: ControlRefusal): void {
  console.warn(
    `[OUTBOX] control "${refusal.act.kind}" refused on ${refusal.messageId.slice(0, 8)}: notice shown`
  );
  changeAccount(userId, (m) => {
    const key = controlRefusalKey(refusal.messageId, refusal.act);
    m.delete(key); // re-inserted last: the eviction order is the order of the refusals
    m.set(key, refusal);
    for (const oldest of m.keys()) {
      if (m.size <= MAX_CONTROL_REFUSALS) break;
      m.delete(oldest);
      console.warn(
        `[OUTBOX] control refusal cap (${MAX_CONTROL_REFUSALS}) reached: oldest evicted`
      );
    }
    return true;
  });
}

/**
 * Forgets the refusal under `act`'s key on `messageId` - ONLY when it is the act that settled or an
 * OLDER one. A retry that finishes late must not erase a NEWER refusal recorded under the same key
 * meanwhile (a 👍 retried, then taken back and that refused): the peers would have the 👍, this device
 * would show none, and no notice would be left.
 */
export function clearControlRefusal(userId: string, messageId: string, act: ControlAct): void {
  changeAccount(userId, (m) => {
    const key = controlRefusalKey(messageId, act);
    const held = m.get(key);
    if (!held) return false;
    if (instantOf(held.act) > instantOf(act)) {
      console.log(
        `[OUTBOX] "${act.kind}" on ${messageId.slice(0, 8)} settled, a NEWER refusal of it kept`
      );
      return false;
    }
    return m.delete(key);
  });
}

/** Forgets the refusals `matches` selects in `userId`'s list. */
function clearWhere(
  userId: string | null,
  matches: (r: ControlRefusal) => boolean,
  why: string
): void {
  if (!userId) return;
  changeAccount(userId, (m) => {
    let removed = 0;
    for (const [key, r] of m) {
      if (!matches(r)) continue;
      m.delete(key);
      removed++;
    }
    if (removed > 0) console.log(`[OUTBOX] ${removed} control refusal(s) dropped: ${why}`);
    return removed > 0;
  });
}

/**
 * Forgets every refusal on `messageId`: the message is deleted (here, by a peer, or by another of
 * this account's devices), so nothing on it is left to retry. `userId` is the account whose delete
 * settled when known (a delete of this device), the signed-in one otherwise (a delete received).
 */
export function clearMessageControlRefusals(messageId: string, userId?: string): void {
  clearWhere(userId ?? boundAccount, (r) => r.messageId === messageId, 'message deleted');
}

/** Forgets every refusal of a conversation purged or retired here: nothing in it can be sent. */
export function clearConversationControlRefusals(conversationId: string): void {
  clearWhere(boundAccount, (r) => r.conversationId === conversationId, 'conversation ended');
}

/** The refusals shown on `messageId`, oldest first. Reactive. */
export function controlRefusalsFor(messageId: string): Array<ControlRefusal & { key: string }> {
  const out: Array<ControlRefusal & { key: string }> = [];
  for (const [key, r] of refusals) if (r.messageId === messageId) out.push({ ...r, key });
  return out;
}

/** Forgets the memory of the bound account (sign-out, account switch). Its persisted list stays. */
export function forgetControlRefusals(): void {
  if (refusals.size > 0 || boundAccount) {
    console.log(`[OUTBOX] signed out: ${refusals.size} control refusal(s) unbound from memory`);
  }
  refusals.clear();
  retrying.clear();
  boundAccount = null;
}

/** Installs the executor a Retry runs (the chat page, with its live context); null removes it. */
export function setControlRetryExecutor(fn: ControlRetryExecutor | null): void {
  executor = fn;
}

/** Whether a Retry can run now; the notice disables its button until a chat page registered. Reactive. */
export function controlRetryAvailable(): boolean {
  return executor !== null;
}

/**
 * Retries the refusal stored under `key`. The executor clears the refusal itself the moment the queue
 * takes the act, BEFORE any local follow-up, so a follow-up that throws cannot leave a mention whose
 * second tap would queue the act twice. Concurrent taps run one retry.
 *
 * @returns true when the act is now queued.
 */
export async function retryControlRefusal(key: string): Promise<boolean> {
  const refusal = refusals.get(key);
  if (!refusal || retrying.has(key)) return false;
  const run = executor;
  if (!run) {
    // The button is disabled while this holds, so reaching it is a caller that bypassed it.
    console.error(`[OUTBOX] retry of "${refusal.act.kind}" impossible: no chat page registered`);
    return false;
  }
  retrying.add(key);
  console.log(
    `[OUTBOX] retrying refused control "${refusal.act.kind}" on ${refusal.messageId.slice(0, 8)}`
  );
  try {
    return await run(refusal);
  } finally {
    retrying.delete(key);
  }
}
