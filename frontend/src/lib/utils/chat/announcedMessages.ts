/**
 * ONE NOTIFICATION PER MESSAGE ON AN IPHONE, WHICHEVER PROCESS DRAWS IT - the page's half of the
 * ledger it shares with the notification extension (Rust `mobile::announced`,
 * `docs/wiki/frontend/ios-notification-ownership.md`).
 *
 * The extension draws every alert push and acknowledges nothing, so the row it announced is
 * redelivered at the app's next connection, and the page used to announce it again: one push, two
 * identical rows after a cold launch, three after a warm resume (iPhone 12, `1.7.3-alpha.6`). The
 * page now ASKS before it raises: the keys of the messages its one banner covers are claimed in the
 * App Group ledger, in one locked step, and a banner none of whose messages is new is not raised.
 */
import { isIosTauriRuntime } from '$lib/utils/appVersion';

/**
 * One message a banner stands for: its sender and its instant - the sender's for an MLS message,
 * the server's `createdAt` for a salon, the instant the push carries too. With the conversation they
 * are its key in the ledger, so two members writing in the same millisecond are two messages.
 */
export type AnnouncedMessage = { senderId: string; at: number };

/** What the ledger answered for one banner (`claim_message_announcement`). */
export type AnnouncementClaim = {
  /** Whether to raise: one message of the banner nobody announced is enough. */
  raise: boolean;
  /** Messages nobody had announced. */
  fresh: number;
  /** Messages the notification extension had announced (its push was shown). */
  byExtension: number;
  /** Messages this app had announced (the same frame delivered twice). */
  byPage: number;
  /** The keys the banner covers - stamped on it so the extension can replace it. */
  keys: string[];
};

/** What the page does with its banner, decided from the claim alone. */
export type AnnouncementDecision =
  | { raise: true; announces: string; line: string }
  | { raise: false; line: string };

/**
 * The decision and its ONE log line, pure so it is asserted beside it. `null` is a ledger that
 * could not answer: the banner is raised (the message must not go unannounced), and the line
 * ACCUSES, since it may be the second announcement of what the extension showed.
 */
export function announcementDecision(
  convKey: string,
  claim: AnnouncementClaim | null,
  failure?: string
): AnnouncementDecision {
  if (claim === null) {
    return {
      raise: true,
      announces: '',
      line: `[NOTIF] ERROR the announced-messages ledger did not answer for ${convKey} (${failure ?? 'no answer'}) - raised, and it may repeat what the extension showed.`,
    };
  }
  if (!claim.raise) {
    return {
      raise: false,
      line: `[NOTIF] Not raised for ${convKey} - every message of it was announced already (by the extension: ${claim.byExtension}, by this app: ${claim.byPage}).`,
    };
  }
  return {
    raise: true,
    announces: claim.keys.join(' '),
    line: `[NOTIF] Raised for ${convKey} - ${claim.fresh} message(s) nobody had announced.`,
  };
}

/**
 * Claims `messages` of `conversationId` for ONE banner, on iOS only (no other runtime has an
 * extension drawing the same messages). Answers the claim, or `{ failure }` when the ledger could
 * not answer.
 */
export async function claimMessageAnnouncement(
  conversationId: string,
  messages: readonly AnnouncedMessage[]
): Promise<{ claim: AnnouncementClaim } | { failure: string }> {
  if (!isIosTauriRuntime()) return { failure: 'not an iPhone' };
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const claim = await invoke<AnnouncementClaim>('claim_message_announcement', {
      conversationId,
      messages: messages
        .filter((m) => m.senderId !== '' && Number.isFinite(m.at) && m.at > 0)
        .map((m) => ({ senderId: m.senderId, at: Math.trunc(m.at) })),
    });
    return { claim };
  } catch (e) {
    return { failure: String(e) };
  }
}
