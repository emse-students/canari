/**
 * THE TEXT OF A SALON MESSAGE THE SERVER HAS NOT YET ANSWERED, kept across a kill or a reload (WP-OFF-2).
 *
 * The composer is cleared the moment a salon message is shown as an echo, and the echo is memory only
 * (a salon is never persisted locally - the server's history is its only store). Between the click and
 * the server's answer the text therefore lived in ONE place, a row that a reload destroys; WP-OFF-1
 * had given the text back on a refusal, and this must not be a regression from it. So the text is also
 * written here, and removed the moment the server answers (settled) or the member discards the row.
 * What is still here at the next start is a message whose fate nobody observed: it is handed back to
 * the composer of its salon, never re-sent on its own (the server does not dedupe on the client id, so
 * an automatic re-send of a message that did arrive would post it twice - the durable queue that can
 * do that safely is WP-OFF-3).
 *
 * localStorage, one key per user: small, synchronous (it must be written BEFORE the POST leaves), and
 * wrapped so that an unavailable store costs the safety net and nothing else - and says so.
 *
 * THE LEDGER IS SHARED BY EVERY TAB OF THE ORIGIN, so "orphaned" cannot mean "not live in THIS tab":
 * a sibling tab opening the same salon would take, and hand back, a text this tab is still sending.
 * Each entry therefore names the PAGE LIFE that wrote it, and that page life holds a Web Lock named
 * after it for as long as it exists. The browser releases a lock when its document goes away - a
 * kill, a reload, a closed tab - so "the owner's lock is no longer held" IS the proof the owner is
 * dead: no heartbeat, no clock. Without Web Locks a foreign entry is never taken (nothing proves its
 * owner dead) and that is logged; an entry of this page life is taken when no live send owns it.
 */

const KEY_PREFIX = 'canari.salon-unsent.';
const OWNER_LOCK_PREFIX = 'canari.salon-unsent.owner.';

/** This page life's identity, written into every entry it records. */
export const SALON_UNSENT_PAGE_LIFE = crypto.randomUUID();

let ownerLockClaimed = false;

/** The browser's lock manager, or null where the engine has none. */
function lockManager(): LockManager | null {
  return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null;
}

/**
 * Takes this page life's owner lock, once, and holds it until the document goes away. Claimed on
 * the first record, which happens before any entry naming this life can be read by another tab.
 */
function claimOwnerLock(): void {
  if (ownerLockClaimed) return;
  const locks = lockManager();
  if (!locks) {
    console.warn(
      '[SALON-UNSENT] no Web Locks: a sibling tab can never prove this page life dead, so its texts come back only here'
    );
    ownerLockClaimed = true;
    return;
  }
  ownerLockClaimed = true;
  void locks
    .request(`${OWNER_LOCK_PREFIX}${SALON_UNSENT_PAGE_LIFE}`, () => new Promise<never>(() => {}))
    .catch((e: unknown) =>
      console.warn(
        `[SALON-UNSENT] owner lock not taken - siblings will see this life as dead: ${String(e)}`
      )
    );
}

/** One unanswered salon message. */
export interface UnsentSalonText {
  messageId: string;
  conversationKey: string;
  text: string;
  /** The page life that wrote it; absent on an entry written before owners existed. */
  owner?: string;
}

function keyFor(userId: string): string {
  return `${KEY_PREFIX}${userId.toLowerCase()}`;
}

function readAll(userId: string): UnsentSalonText[] {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as UnsentSalonText[]) : [];
  } catch (e) {
    console.warn(`[SALON-UNSENT] ledger unreadable: ${String(e)}`);
    return [];
  }
}

function writeAll(userId: string, entries: UnsentSalonText[]): void {
  try {
    if (entries.length === 0) localStorage.removeItem(keyFor(userId));
    else localStorage.setItem(keyFor(userId), JSON.stringify(entries));
  } catch (e) {
    console.warn(`[SALON-UNSENT] ledger not written - a kill now loses the text: ${String(e)}`);
  }
}

/** Records the text of a salon message about to be sent. */
export function recordUnsentSalonText(userId: string, entry: UnsentSalonText): void {
  claimOwnerLock();
  const owned = { ...entry, owner: SALON_UNSENT_PAGE_LIFE };
  writeAll(userId, [...readAll(userId).filter((e) => e.messageId !== entry.messageId), owned]);
}

/** Forgets one entry: the server answered, or the member gave the message up. */
export function clearUnsentSalonText(userId: string, messageId: string): void {
  clearUnsentSalonTexts(userId, [messageId]);
}

/**
 * Forgets every entry the server is PROVEN to hold: its broadcast frame or a history page carried
 * the client id sealed inside the row. Without this, a send whose POST reply was lost and that the
 * frame settled kept its text here for ever, and the next page life (or a sibling tab) handed the
 * text of a DELIVERED message back to the composer - one click from posting it twice.
 */
export function clearUnsentSalonTexts(userId: string, messageIds: Iterable<string>): void {
  const ids = new Set(messageIds);
  if (ids.size === 0) return;
  const all = readAll(userId);
  const kept = all.filter((e) => !ids.has(e.messageId));
  if (kept.length !== all.length) {
    console.debug(
      `[SALON-UNSENT] ${all.length - kept.length} entr(y/ies) forgotten: the server holds them`
    );
    writeAll(userId, kept);
  }
}

/** The page lives whose owner lock is held or queued right now, or null without Web Locks. */
async function livePageLives(): Promise<Set<string> | null> {
  const locks = lockManager();
  if (!locks) return null;
  const snapshot = await locks.query();
  const names = [...(snapshot.held ?? []), ...(snapshot.pending ?? [])]
    .map((l) => l.name ?? '')
    .filter((n) => n.startsWith(OWNER_LOCK_PREFIX))
    .map((n) => n.slice(OWNER_LOCK_PREFIX.length));
  return new Set(names);
}

/**
 * Removes and returns the entries of `conversationKey` whose writer is PROVEN gone: the leftovers of
 * a dead page life, to hand back to the composer. An entry of THIS page life is taken only when no
 * live send owns it; an entry of another page life only when its owner lock is no longer held.
 *
 * @param live Message ids this page life is still sending or can retry.
 */
export async function takeOrphanedSalonTexts(
  userId: string,
  conversationKey: string,
  live: ReadonlySet<string>
): Promise<UnsentSalonText[]> {
  const alive = await livePageLives();
  const all = readAll(userId);
  let foreignKept = 0;
  const taken = all.filter((e) => {
    if (e.conversationKey !== conversationKey) return false;
    if (e.owner === SALON_UNSENT_PAGE_LIFE) return !live.has(e.messageId);
    if (e.owner === undefined) return true;
    if (alive !== null && !alive.has(e.owner)) return true;
    foreignKept++;
    return false;
  });
  if (foreignKept > 0) {
    if (alive === null) {
      console.warn(
        `[SALON-UNSENT] ${foreignKept} entr(y/ies) of another page life kept: no Web Locks to prove it dead`
      );
    } else {
      console.debug(`[SALON-UNSENT] ${foreignKept} entr(y/ies) kept: a live sibling tab owns them`);
    }
  }
  if (taken.length === 0) return [];
  const takenIds = new Set(taken.map((e) => e.messageId));
  writeAll(
    userId,
    all.filter((e) => !takenIds.has(e.messageId))
  );
  return taken;
}
