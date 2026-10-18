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
 * plus the emoji for a reaction: only an act with the SAME key supersedes a refusal (a newer edit, a
 * newer pin state, the same emoji placed or taken back), and a delete clears the message's every one.
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

/** The bound account's refusals by {@link controlRefusalKey}, in insertion order. */
const refusals = new SvelteMap<string, ControlRefusal>();
const retrying = new SvelteSet<string>();
let boundAccount: string | null = null;
let executor: ControlRetryExecutor | null = null;

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

function persist(): void {
  if (!boundAccount) return;
  const key = ACCOUNT_KEY.controlRefusals(boundAccount);
  try {
    if (refusals.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify([...refusals.values()]));
  } catch (e) {
    // The mention still shows for this session; only its survival across a reload is lost.
    console.error(
      `[OUTBOX] control refusals not persisted (${refusals.size}), a reload will forget them: ${String(e)}`
    );
  }
}

/**
 * Binds the store to `userId`, reading its persisted refusals. A no-op when already bound to it, so
 * every writer calls it with the acting account and a sign-in of another account rebinds.
 */
export function loadControlRefusals(userId: string): void {
  if (!userId || boundAccount === userId) return;
  refusals.clear();
  boundAccount = userId;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(ACCOUNT_KEY.controlRefusals(userId));
  } catch (e) {
    console.error(`[OUTBOX] control refusals unreadable, none shown: ${String(e)}`);
    return;
  }
  if (!raw) return;
  try {
    const parsed: unknown = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed.filter(isRefusal) : [];
    for (const r of list) refusals.set(controlRefusalKey(r.messageId, r.act), r);
    console.log(`[OUTBOX] ${list.length} refused control action(s) restored`);
  } catch (e) {
    console.error(`[OUTBOX] control refusals corrupt, dropped: ${String(e)}`);
    persist();
  }
}

/** Records a refusal for `userId`, replacing only an earlier refusal with the same key. */
export function recordControlRefusal(userId: string, refusal: ControlRefusal): void {
  loadControlRefusals(userId);
  console.warn(
    `[OUTBOX] control "${refusal.act.kind}" refused on ${refusal.messageId.slice(0, 8)}: notice shown`
  );
  refusals.set(controlRefusalKey(refusal.messageId, refusal.act), refusal);
  persist();
}

/** Forgets the refusal of `act` on `messageId`: the same act, or a newer one with its key, was queued. */
export function clearControlRefusal(userId: string, messageId: string, act: ControlAct): void {
  loadControlRefusals(userId);
  if (refusals.delete(controlRefusalKey(messageId, act))) persist();
}

/**
 * Forgets every refusal on `messageId` of the bound account: the message is deleted (here, by a peer,
 * or by another of this account's devices), so nothing on it is left to retry.
 */
export function clearMessageControlRefusals(messageId: string): void {
  let removed = 0;
  for (const [key, r] of refusals) {
    if (r.messageId !== messageId) continue;
    refusals.delete(key);
    removed++;
  }
  if (removed === 0) return;
  console.log(
    `[OUTBOX] ${removed} refusal(s) on ${messageId.slice(0, 8)} dropped: message deleted`
  );
  persist();
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
  if (!executor) {
    console.error(`[OUTBOX] retry of "${refusal.act.kind}" impossible: no chat page registered`);
    return false;
  }
  retrying.add(key);
  console.log(
    `[OUTBOX] retrying refused control "${refusal.act.kind}" on ${refusal.messageId.slice(0, 8)}`
  );
  try {
    return await executor(refusal);
  } finally {
    retrying.delete(key);
  }
}
