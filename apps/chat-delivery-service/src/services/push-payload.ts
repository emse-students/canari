/**
 * Common, transport-agnostic description of a queued-message push.
 *
 * FCM is the single transport: the Android data payload and the iOS APNs payload
 * (relayed by FCM) both consume this so the two stay in sync. The server never
 * sees the MLS plaintext, so only
 * metadata it legitimately knows (sender/group display names, the inline
 * ciphertext, timing) ends up in the payload. The client decrypts and rewrites
 * the user-visible text locally (Android background service / iOS NSE).
 */
export interface PushMessageInput {
  /** Target group id. */
  groupId: string;
  /** Id of the durable queued-message row (used to ACK / fetch the proto). */
  queuedMessageId: string;
  /** Sender user id. */
  senderId: string;
  /** Resolved sender display name (empty when unknown). */
  senderName: string;
  /** Resolved group name for group chats (empty for DMs). */
  groupName: string;
  /** Inline base64 MLS ciphertext, or '' when too large (client fetches it). */
  proto: string;
  /** When true, no notification is shown (read receipts, own-device copies, control frames). */
  silent: boolean;
  /** When true, the payload carries an MLS Welcome rather than an application message. */
  isWelcome: boolean;
  /** Server queue time (ISO 8601) so the client can show the right timestamp pre-decryption. */
  createdAt: string;
}

/** APNs payload budget: Apple rejects alert pushes whose body exceeds 4 KB. */
export const APNS_PAYLOAD_LIMIT = 4096;

/**
 * Generic notification text used before the client decrypts the real content.
 * The iOS NSE replaces this with the decrypted preview; if decryption fails the
 * user still sees who the message is from.
 */
const APNS_FALLBACK_BODY = 'Nouveau message';

/**
 * Builds the flat `Record<string, string>` data map shared by the FCM data
 * payload and the APNs custom keys. FCM requires every data value to be a
 * string, so booleans are serialised as 'true' / 'false'.
 */
export function buildPushDataFields(input: PushMessageInput): Record<string, string> {
  return {
    type: 'message',
    groupId: input.groupId,
    queuedMessageId: input.queuedMessageId,
    senderId: input.senderId,
    senderName: input.senderName,
    groupName: input.groupName,
    proto: input.proto,
    silent: input.silent ? 'true' : 'false',
    isWelcome: input.isWelcome ? 'true' : 'false',
    createdAt: input.createdAt,
  };
}

/** A ready-to-send APNs request: JSON body plus the headers that drive delivery. */
export interface ApnsRequest {
  /**
   * The JSON payload: the required `aps` block plus custom top-level keys for the
   * NSE. Typing `aps` as required lets this drop straight into FCM's
   * `apns.payload` (firebase-admin `ApnsPayload`, which mandates `aps`).
   */
  payload: { aps: Record<string, unknown>; [key: string]: unknown };
  /** `alert` for user-visible messages, `background` for silent state-sync frames. */
  pushType: 'alert' | 'background';
  /** APNs priority: 10 for alerts, 5 for background pushes. */
  priority: number;
}

/**
 * Builds the APNs request for a queued message.
 *
 * Visible messages use `mutable-content: 1` so the Notification Service
 * Extension runs and can decrypt + rewrite the alert; a generic title/body is
 * provided as a fallback. Silent frames use `content-available: 1` (background
 * wake, no banner), mirroring the Android data-only push.
 *
 * @param input       Transport-agnostic message description.
 * @param dataFields  Output of {@link buildPushDataFields}, embedded as custom
 *                    top-level keys alongside `aps` for the client to read.
 */
export function buildApnsRequest(
  input: PushMessageInput,
  dataFields: Record<string, string>
): ApnsRequest {
  if (input.silent) {
    return {
      payload: {
        aps: { 'content-available': 1 },
        ...dataFields,
      },
      pushType: 'background',
      priority: 5,
    };
  }

  const title = input.senderName || input.groupName || 'Canari';

  return {
    payload: {
      aps: {
        'mutable-content': 1,
        alert: { title, body: APNS_FALLBACK_BODY },
        sound: 'default',
        // Groups a conversation's notifications together in the iOS notification centre.
        'thread-id': input.groupId,
      },
      ...dataFields,
    },
    pushType: 'alert',
    priority: 10,
  };
}
