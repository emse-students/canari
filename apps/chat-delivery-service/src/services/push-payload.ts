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

/**
 * FCM's limit on one message, and the quantity it is measured over: everything the message
 * carries, KEYS INCLUDED - not the ciphertext alone, which is only its largest entry.
 */
export const FCM_DATA_LIMIT = 4096;

/**
 * Byte size of an FCM `data` map as FCM counts it: every key plus every value.
 *
 * @param fields - The flat string map about to be sent as `data`.
 */
export function measureDataFields(fields: Record<string, string>): number {
  let total = 0;
  for (const [key, value] of Object.entries(fields)) {
    total += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8');
  }
  return total;
}

/**
 * Byte size of an APNs payload: its JSON encoding, which is what is actually transmitted.
 *
 * @param payload - The `apns.payload` object handed to FCM.
 */
export function measureApnsPayload(payload: object): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

/**
 * How many bytes the inline ciphertext may occupy, given everything else the payload carries.
 *
 * WHY THIS IS COMPUTED AND NOT A CONSTANT. The guard here used to be
 * `Buffer.byteLength(protoB64) <= 3_500`, applied to the ciphertext ALONE under a comment that
 * correctly stated the 4 KB budget belongs to the PAYLOAD. The payload is not the proto: nine
 * other entries ride with it, FCM counts key names too, `senderId` is 64 hex characters on this
 * deployment, two ids are UUIDs, and `senderName` / `groupName` are unbounded USER TEXT. A limit
 * is only evidence for the quantity it was measured over.
 *
 * **The budget is the tighter of the two representations**, because one payload is built and sent
 * to every one of a user's devices: the FCM data map (~289 B of fixed fields) and the APNs
 * payload, whose JSON framing plus the `aps` block costs about 216 B more. Sizing against the data
 * map alone would let a message through that APNs then refuses.
 *
 * @param input - The message description, whose `proto` is ignored here.
 * @returns Bytes available for `proto`; zero or negative when the fixed fields already fill it.
 */
export function inlineProtoBudget(input: PushMessageInput): number {
  const empty: PushMessageInput = { ...input, proto: '' };
  const dataBytes = measureDataFields(buildPushDataFields(empty));
  const apnsBytes = measureApnsPayload(buildApnsRequest(empty, buildPushDataFields(empty)).payload);
  // Both representations already carry the `proto` key with an empty value, so each byte of
  // ciphertext costs exactly one byte in each - the subtraction is exact, not an estimate.
  return FCM_DATA_LIMIT - Math.max(dataBytes, apnsBytes);
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

/**
 * Builds the APNs request for a non-MLS internal push (community channel messages,
 * social posts, form reminders and their silent read-receipt frames), sent through
 * {@link https | sendPushToUser}.
 *
 * Without an `apns` block FCM delivers these as a data-only message, which iOS does
 * NOT surface in the background and which never triggers the Notification Service
 * Extension. Visible pushes therefore get `mutable-content: 1` (so the NSE runs and
 * can decrypt an encrypted channel message) plus a fallback alert; silent control
 * frames (`type: 'channel_read'`, or an explicit `silent: 'true'`) get
 * `content-available: 1` so they wake the client without showing a banner.
 *
 * The custom `data` fields are spread into the payload because FCM does not merge the
 * top-level data map into the APNs payload - the NSE reads channelId / ciphertext /
 * nonce / keyVersion from here (same self-contained approach as {@link buildApnsRequest}).
 *
 * @param title  Fallback alert title (channel or asso name).
 * @param body   Fallback alert body; a generic string is used when empty.
 * @param data   Flat string data map sent to the client (already includes type, ids, ...).
 */
export function buildInternalApnsRequest(
  title: string,
  body: string,
  data: Record<string, string>
): ApnsRequest {
  const isSilent = data.type === 'channel_read' || data.silent === 'true';
  if (isSilent) {
    return {
      payload: { aps: { 'content-available': 1 }, ...data },
      pushType: 'background',
      priority: 5,
    };
  }

  // Per-conversation grouping: channel messages stack under their channel thread; a reaction
  // stacks under the CONVERSATION it belongs to, like the message it is attached to; anything
  // else falls back to a coarse per-kind thread.
  //
  // The extension rewrites this thread itself when it runs, so this line is what applies when it
  // does NOT - iOS may skip it under memory pressure, and a reaction filed under `canari_social`
  // there is the stray notification this whole change removes.
  const threadId = data.channelId
    ? `channel_${data.channelId}`
    : data.reaction === 'true' && data.groupId
      ? data.groupId
      : data.type === 'form_reminder'
        ? 'canari_forms'
        : 'canari_social';

  return {
    payload: {
      aps: {
        'mutable-content': 1,
        alert: { title: title || 'Canari', body: body || APNS_FALLBACK_BODY },
        sound: 'default',
        'thread-id': threadId,
      },
      ...data,
    },
    pushType: 'alert',
    priority: 10,
  };
}
