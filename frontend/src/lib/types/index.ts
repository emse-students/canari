/**
 * Lifecycle state of a conversation - the SINGLE source replacing the old
 * `(isReady, deletedRemotely)` pair.
 *  - `active` : MLS group established, active member -> read + SEND.
 *  - `pending`: placeholder awaiting a Welcome (recovery applicable) -> read-only.
 *  - `removed`: deleted by a peer / exclusion / pending local deletion -> read-only + banner,
 *               stays until MANUAL DELETION (rules 2 & 4).
 * Predicates and transition logic: `$lib/utils/chat/groupLifecycle`.
 */
import type { OutboxEntry, PageKey } from '$lib/db/types';
import type { RecordedAuthorship } from '$lib/crypto/messageAuthorship';

export type ConversationLifecycle = 'active' | 'pending' | 'removed';

/**
 * The state of ONE `(user, emoji)` pair on a message - placed or taken back.
 *
 * A removal is kept as an entry with `removed: true` rather than dropped from the list, which is
 * what makes it reach a device that still holds the placement. There is exactly one entry per pair,
 * so a place/remove cycle does not grow the set: this is bounded, not a growing tombstone log.
 *
 * Both fields are optional because rows and frames written before they existed lack them, and both
 * defaults say the same thing - a bare `{emoji, userId}` is a placement of unknown age, which is
 * exactly what it was. It therefore loses any merge against a dated entry.
 */
export interface MessageReaction {
  emoji: string;
  userId: string;
  /** Unix ms at which this pair last changed state. The larger one wins the merge. */
  at?: number;
  /** True when the user took the reaction back. Absent or false = the reaction stands. */
  removed?: boolean;
  /**
   * The reactor's signed frame that set this state, kept so a history bundle can prove it
   * (`$lib/crypto/messageAuthorship`). Absent on entries older than it, or set by this device.
   */
  proof?: RecordedAuthorship;
}

/**
 * Read state for a conversation: `userId (lowercase) -> the instant that user has read up to`.
 * Merged as `max`, which is what makes it converge. A conversation holds two such maps, one per
 * clock (`readWatermarks`, `serverReadWatermarks`); see `$lib/utils/chat/readState` for which is
 * compared against what, the merge and every derived question.
 */
export type ReadWatermarks = Record<string, number>;

/** Compact reference to a quoted/replied-to message. Used in ChatMessage, envelopes, and addMessageToChat options. */
export type MessageReference = {
  id: string;
  senderId: string;
  content: string;
};

/**
 * Where an own message stands on its way to the server. `unconfirmed` exists for a salon message
 * only (WP-OFF-2): the request left and NO answer came back while the link still works (a gateway 5xx
 * after the server may have stored it, a stall). Nobody knows whether the server holds it, so it is
 * neither `sent` nor `error`; the row offers Retry - safe, the server answers a repeat of its client
 * id with the row it holds (WP-OFF-3) - Delete and "put back in the composer", and the frame or a
 * history page settles it if the server did take it. With the link DOWN the row is `pending` instead,
 * owed to the reconnect.
 */
export type MessageSendStatus = 'pending' | 'sending' | 'sent' | 'error' | 'unconfirmed';

/** Options accepted by all addMessageToChat call sites. Centralised here so every interface stays in sync. */
export interface AddMessageToChatOptions {
  replyTo?: MessageReference;
  isSystem?: boolean;
  messageId?: string;
  timestamp?: Date;
  status?: MessageSendStatus;
  /** True when content came from FCM preview cache (plain text, upgradeable by MLS envelope). */
  isFcmPreview?: boolean;
  /** When true, keep the message in memory only (e.g. server-authoritative community channels). */
  skipDbSave?: boolean;
  /**
   * The outbox entry to make durable IN THE SAME TRANSACTION as this message.
   *
   * A message the sender can see must be a message the queue will send, and the two used to be two
   * awaits: the echo was persisted, then the entry was queued. A document torn down between them -
   * a reload fired inside the send's own async tail - left a `pending` row on disk that no queue
   * knew about, so it was never sent, never retried and never reported. Measured on 2026-09-05,
   * TAB-5 round 0: the peer had nothing, the sender had the message, and the console showed
   * `sendChatMessage` with no `[OUTBOX] Queued` after it.
   *
   * Passing the entry here writes both rows in one IndexedDB transaction, so the pair is atomic and
   * neither state can exist alone. Reconciling them afterwards was the alternative and is refused:
   * a ledger that repairs a race is a witness to it, not a fix.
   */
  outboxEntry?: OutboxEntry;
  /** Monotonic catch-up index (MLS queue / history replay order); used for in-session ordering only. */
  ingestSequence?: number;
  /**
   * The server's acceptance of the message (Unix ms): `queuedCreatedAt` in the MLS delivery
   * envelope. Persisted, and THE key the conversation is ordered, shown and read by when present
   * (`messageTime`, owner 2026-10-31).
   */
  serverTimestamp?: number;
  /**
   * A community-salon echo shown before the server has a row (WP-OFF-2): flags the row
   * `awaitingServerId` and keeps it OUT of the cross-tab announcements, which would hand a sibling
   * tab a row it can never reconcile (it would show the message twice once the server row arrives).
   */
  salonEcho?: boolean;
  /**
   * The client UUID sealed inside an OWN salon message's ciphertext, carried to the sibling tabs
   * with its `message_added` so the tab that composed it settles its echo instead of drawing the
   * server's row beside it (WP-OFF-2).
   */
  clientMessageId?: string;
  /**
   * The author's signed frame for this message (`$lib/crypto/messageAuthorship`): set by the MLS
   * receive paths from a proof mls-core verified, and by a history bundle from a proof this device
   * checked. Persisted in the sealed row so this device can relay it in its own bundles.
   */
  authorship?: RecordedAuthorship;
  /**
   * A restored message whose author nothing proved: relayed by another member, with no signature
   * (an older build, or a proof this device could not check). Shown with a marker, never refused.
   */
  restoredUnverified?: boolean;
  /**
   * This call is the ONLY writer the row will ever get on this device - the acting device's own
   * visible notice (`sendVisibleNotice`), which MLS never echoes back. Such a row takes the live
   * path even during a bulk drain, exactly as an own message does: the drain buffer is discarded
   * without flushing by a second drain start and by `resetMessageCatchupState`, and nothing else
   * would ever write the row again.
   */
  soleWriter?: boolean;
}

/**
 * WHAT A BATCH OF MESSAGES IS - the one thing every caller of `batchAddMessages` knows and the
 * notification decision inside it cannot see.
 *
 * `arrival`: these came over the wire now, for the first time. The reader has not been told.
 * `restore`: these are an ARCHIVE being replayed into the store - a peer's history bundle. The
 * reader has had them before, on this device or another, which is exactly why a peer still holds
 * them to send.
 *
 * IT IS REQUIRED, DELIBERATELY. A default would have to pick one, and picking `arrival` is the
 * defect this type exists to end: a history bundle raised an OS notification for a message the
 * user had already dismissed, at every launch (`G2`, reported 2026-09-18).
 */
export type MessageBatchOrigin = 'arrival' | 'restore';

export interface ChatMessage {
  id: string;
  senderId: string;
  content: string;
  timestamp: Date;
  editedAt?: Date;
  isOwn: boolean;
  isSystem?: boolean;
  /**
   * Optimistic send state: undefined = received/confirmed, 'pending' = queued in the outbox
   * (group not yet sendable / offline), 'sending' = handed to MLS and in-flight, 'sent' =
   * confirmed by the server, 'error' = permanent failure (group deleted server-side, or a salon
   * send the server refused), 'unconfirmed' = a salon send with no answer (see {@link MessageSendStatus}).
   */
  status?: MessageSendStatus;
  replyTo?: MessageReference;
  reactions?: MessageReaction[];
  isEdited?: boolean;
  isDeleted?: boolean;
  /** In-session ordering during bulk catch-up (not persisted); use serverTimestamp for stable reload ordering. */
  ingestSequence?: number;
  /**
   * The server's acceptance of this message (Unix ms): `queued_message.createdAt` on a recipient's
   * copy, the `receivedAt` the send answered on the author's, a salon row's `createdAt`. Persisted.
   * When present it is THE instant the row is ordered, shown and read by (`messageTime`, owner
   * 2026-10-31); `timestamp` - the author's `sentAt` - is the key only of a row without it.
   */
  serverTimestamp?: number;
  /** True when displayed from FCM preview before full MLS envelope arrives. */
  isFcmPreview?: boolean;
  /**
   * A community-salon message shown BEFORE the server has a row for it (WP-OFF-2): `id` is the
   * client UUID, not the server's, so every action addressed by a server id (react, edit, delete,
   * pin) is unavailable until `settleSalonEcho` re-keys it. Memory only, never persisted.
   */
  awaitingServerId?: boolean;
  /** See {@link AddMessageToChatOptions.restoredUnverified}: the row shows its author is unproven. */
  restoredUnverified?: boolean;
  /** Where the store's page read found this row (`StoredMessage.pageKey`); absent on a row that did not come from one. */
  pageKey?: PageKey;
}

/**
 * Runtime representation of a conversation (DM, group, or channel).
 *
 * `messages` is loaded lazily - it can be empty while the conversation is still
 * visible in the sidebar. `lastMessageAt` provides a stable sort key even before
 * messages are loaded; it is initialised from `ConversationMeta.updatedAt` on
 * startup and kept up-to-date by `addMessageToChat` / `batchAddMessages`.
 */
export interface Conversation {
  /** Primary key - the MLS groupId UUID (same as ConversationMeta.id). */
  id: string;
  /** Display name shown in the UI (e.g. peer username, group name). */
  name: string;
  /** Human-readable auxiliary identifier (peer username for DMs, group display name for groups). */
  contactName: string;
  messages: ChatMessage[];
  /**
   * Lifecycle state (see {@link ConversationLifecycle}) - the SINGLE source replacing the old
   * `(isReady, deletedRemotely)` pair. `active` = sendable; `pending` = placeholder awaiting a
   * Welcome (recovery applicable); `removed` = deleted/excluded, read-only + banner.
   */
  lifecycle: ConversationLifecycle;
  mlsStateHex: string | null;
  unreadCount?: number;
  /**
   * Read state for the whole conversation: one monotone instant per participant, merged as `max`.
   * Replaces the per-message `readBy` array - see `$lib/utils/chat/readState` for why the read
   * state of a conversation cannot live on its messages.
   */
  readWatermarks?: ReadWatermarks;
  /**
   * The read state on the SERVER's clock, next to `readWatermarks` (the stamped one). See
   * `$lib/utils/chat/readState`.
   */
  serverReadWatermarks?: ReadWatermarks;
  /**
   * Where the shared history of this conversation begins - below it nobody claims and nobody
   * answers. Monotone, merged as `max`, absent meaning zero. Nothing moves it today; see
   * `$lib/utils/chat/historyWindow`.
   */
  historyFloor?: number;
  /**
   * The instant this conversation came into existence, as the SERVER records the group's creation.
   *
   * Distinct from {@link Conversation.historyFloor}, which they are easy to confuse. The floor is
   * shared, converged and monotone - what the MEMBERS agree the history begins at - and moving it
   * is irreversible. This is a fixed server fact about the group's row, local, never merged and
   * never sent. They answer different questions and only this one answers "could anything older
   * exist at all".
   *
   * Absent means unknown - a row written before this shipped, or a server that does not send it -
   * and unknown ASKS, which is the safe direction.
   */
  startedAt?: number;
  conversationType?: 'direct' | 'group' | 'channel';
  directPeerId?: string;
  /** Media-service ID of the group image (unencrypted avatar). Channels never carry one. */
  imageMediaId?: string | null;
  /**
   * This account's seat is an invitation-link ask no member has answered yet, as the server's
   * conversation list last said - see `ConversationMeta.awaitingAdmission`. Read as a NEVER-ADMITTED
   * conversation only while the row is `pending` (`isNeverAdmitted`, `admissionState.ts`): a row
   * that was ever active was admitted.
   */
  awaitingAdmission?: boolean;
  /**
   * Unix-ms timestamp of the most recent message in this conversation.
   * Updated on every addMessageToChat / batchAddMessages call so the sidebar
   * can sort correctly even when `messages[]` is still empty (startup stubs).
   */
  lastMessageAt?: number;
}
