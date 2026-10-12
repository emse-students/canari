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
 */

const KEY_PREFIX = 'canari.salon-unsent.';

/** One unanswered salon message. */
export interface UnsentSalonText {
  messageId: string;
  conversationKey: string;
  text: string;
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
  writeAll(userId, [...readAll(userId).filter((e) => e.messageId !== entry.messageId), entry]);
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

/**
 * Removes and returns the entries of `conversationKey` that no live send in THIS page life owns:
 * the leftovers of a previous life, to hand back to the composer.
 *
 * @param live Message ids this page life is still sending or can retry.
 */
export function takeOrphanedSalonTexts(
  userId: string,
  conversationKey: string,
  live: ReadonlySet<string>
): UnsentSalonText[] {
  const all = readAll(userId);
  const taken = all.filter((e) => e.conversationKey === conversationKey && !live.has(e.messageId));
  if (taken.length === 0) return [];
  const takenIds = new Set(taken.map((e) => e.messageId));
  writeAll(
    userId,
    all.filter((e) => !takenIds.has(e.messageId))
  );
  return taken;
}
