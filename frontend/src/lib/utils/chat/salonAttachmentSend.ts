/**
 * A COMMUNITY-SALON ATTACHMENT IS DRAWN AT THE TAP, AND ITS ROW CARRIES ITS UPLOAD (2026-11-02).
 *
 * The defect (owner, 2026-11-02): a file sent in a conversation - a heavy one above all - vanished
 * from the composer at the tap and appeared in the thread only much later, with nothing in between.
 * In a salon that was the design: the send uploaded the whole file INLINE and drew no row at all,
 * so the message existed on screen only once the server's `channel.message.created` frame came back.
 * The only sign of life was a spinner on the composer's attach button, which a phone-width web
 * viewport does not even show. A DM or group file never had that gap: its row is drawn at the tap
 * and the outbox writes its upload view (`uploadProgress.svelte.ts`).
 *
 * Now a salon attachment takes the same shape. The caller draws its ECHO at the tap (the salon
 * text's `awaitingServerId` row, `salonEcho.ts`) with the placeholder envelope, and this module:
 *
 *  1. waits for the salon's send gate (`salonSendGate.ts`) BEFORE uploading, as before - a salon that
 *     never loads leaves no orphan blob - the row saying `queued` meanwhile;
 *  2. uploads the file with the real transfer's progress events written into the SAME upload view
 *     the outbox writes, so the bubble draws the same ring and caption (`UploadAction`);
 *  3. swaps the real envelope into the echo BEFORE the POST, so whichever answer settles the echo
 *     first - the POST's reply or the broadcast frame - leaves a row that names its blob;
 *  4. hands the sealed message to the salon send machinery (`deliverSalonAttachment`), which owns
 *     the rest exactly as for a text: the hold, the reconnect, `unconfirmed`, Retry and Discard.
 *
 * Until step 3 this module owns the row's retry and cancel ({@link setUploadOwner}): a failure
 * leaves the row in place with its Retry, a cancel aborts the transfer and withdraws the row. A
 * transport failure while the device is offline is owed to the reconnect (`salonOwed.ts`), the event
 * that changes the answer - never a timer.
 *
 * MEMORY ONLY, as the salon text's in-flight registry: the file lives in this page's `File`. A reload
 * mid-upload loses the row and the file together - it never leaves a row that names nothing.
 */
import type { OutboxEntry } from '$lib/db';
import type { MediaRef } from '$lib/media';
import type { XhrUploadOptions } from '$lib/utils/uploadXhr';
import { UploadAbortedError, UploadNetworkError, UploadStalledError } from '$lib/utils/uploadXhr';
import { isTransportFailure } from '$lib/utils/transportFailure';
import { refusalStatus } from '$lib/utils/apiRefusal';
import type { SalonGateOutcome } from '$lib/utils/graine/salonSendGate';
import { forgetOwedSalonWrite, oweSalonWrite } from './salonOwed';
import { buildMediaMessage } from './outbox';
import {
  clearUpload,
  patchUpload,
  setUploadOwner,
  type UploadPhase,
} from './uploadProgress.svelte';

/** What one salon attachment needs from its surroundings - injected, so the rule is testable. */
export interface SalonAttachmentDeps {
  /** The salon's send gate: `ready`, or the reason it never will be. */
  gate: () => Promise<SalonGateOutcome>;
  /** Uploads the file (encrypted on this device) under a live token; rejects typed. */
  upload: (file: File, transport: XhrUploadOptions) => Promise<MediaRef>;
  /** Puts the real envelope into the echo (`applySalonEchoChange`, `content`). */
  showContent: (content: string) => void;
  /** Seals and posts the message, its echo then owned by the salon send machinery. */
  deliver: (payload: Uint8Array) => Promise<string | null>;
  /** Removes the echo: the member cancelled, or the session that drew it ended. */
  withdraw: () => void;
  /** Says a refusal on the banner of the conversation still on screen (the caller checks that). */
  refused: (sentence: string) => void;
  /** Whether the device is known to be offline right now (`connectivity.isOffline`). */
  isOffline: () => boolean;
  /** The member-facing sentence for a refusal, or for a gate that will never open. */
  describe: (failure: SalonAttachmentFailure) => string;
  log: (msg: string) => void;
}

/** Why an attachment did not leave, as the sentence-maker needs it. */
export type SalonAttachmentFailure =
  | { kind: 'gate'; reason: Exclude<SalonGateOutcome, { kind: 'ready' }>['reason'] }
  | { kind: 'upload'; status: number | null; error: unknown };

interface Attachment {
  messageId: string;
  conversationKey: string;
  sentAt: number;
  file: File;
  media: NonNullable<OutboxEntry['media']>;
  deps: SalonAttachmentDeps;
  attempts: number;
  /** The running attempt's abort; null while none runs. */
  control: AbortController | null;
}

const attachments = new Map<string, Attachment>();
/** One upload at a time per salon, in tap order: the server dates a row by its arrival. */
const tails = new Map<string, Promise<void>>();

const owedKey = (messageId: string) => `attachment:${messageId}`;

/**
 * Starts the upload of an attachment whose echo the caller has ALREADY drawn under `messageId`.
 * Returns at once: the row carries every later state.
 */
export function startSalonAttachment(input: {
  messageId: string;
  conversationKey: string;
  sentAt: number;
  file: File;
  media: NonNullable<OutboxEntry['media']>;
  deps: SalonAttachmentDeps;
}): void {
  const item: Attachment = { ...input, attempts: 0, control: null };
  attachments.set(item.messageId, item);
  setUploadOwner(item.messageId, {
    retry: () => retrySalonAttachment(item.messageId),
    cancel: () => cancelSalonAttachment(item.messageId),
  });
  patchUpload(item.messageId, { phase: 'queued', loaded: 0, total: 0, attempt: 0 });
  item.deps.log(
    `[MEDIA] salon attachment ${item.messageId.slice(0, 8)}… drawn at the tap (${item.file.size} bytes), queued behind its salon's uploads`
  );
  enqueue(item);
}

/** Chains one attempt behind the salon's previous upload. */
function enqueue(item: Attachment): void {
  const previous = tails.get(item.conversationKey) ?? Promise.resolve();
  const next = previous.then(() => runAttempt(item.messageId));
  tails.set(item.conversationKey, next);
  void next.finally(() => {
    if (tails.get(item.conversationKey) === next) tails.delete(item.conversationKey);
  });
}

/** Whether `messageId` is an attachment this module still owns (before its POST). */
export function isSalonAttachmentPending(messageId: string): boolean {
  return attachments.has(messageId);
}

/** The row's Retry: a new attempt now, unless one is running. */
export function retrySalonAttachment(messageId: string): void {
  const item = attachments.get(messageId);
  if (!item) {
    console.debug(`[MEDIA] retry of salon attachment ${messageId.slice(0, 8)}…: none registered`);
    return;
  }
  if (item.control) {
    item.deps.log(`[MEDIA] retry of ${messageId.slice(0, 8)}… ignored: an attempt is running`);
    return;
  }
  forgetOwedSalonWrite(owedKey(messageId));
  item.deps.log(`[MEDIA] salon attachment ${messageId.slice(0, 8)}… retried by its author`);
  patchUpload(messageId, { phase: 'queued', loaded: 0, total: 0 });
  enqueue(item);
}

/** The row's cancel: the transfer is aborted, nothing is sent, the row goes. */
export function cancelSalonAttachment(messageId: string): void {
  const item = attachments.get(messageId);
  if (!item) return;
  item.deps.log(`[MEDIA] salon attachment ${messageId.slice(0, 8)}… cancelled by its author`);
  forget(item);
  item.control?.abort('cancel');
  item.deps.withdraw();
}

/** Forgets every attachment of the session that ended: aborted, rows withdrawn, nothing sent. */
export function forgetSalonAttachments(): void {
  if (attachments.size > 0) {
    console.log(`[MEDIA] signed out: ${attachments.size} salon attachment(s) abandoned unsent`);
  }
  // A Map visits each entry once even as `forget` deletes it.
  for (const item of attachments.values()) {
    forget(item);
    item.control?.abort('cancel');
    item.deps.withdraw();
  }
  tails.clear();
}

function forget(item: Attachment): void {
  attachments.delete(item.messageId);
  setUploadOwner(item.messageId, null);
  clearUpload(item.messageId);
  forgetOwedSalonWrite(owedKey(item.messageId));
}

/** Parks the row in `phase`, with its Retry (the bubble's ring offers it). */
function park(item: Attachment, phase: UploadPhase): void {
  patchUpload(item.messageId, { phase });
}

async function runAttempt(messageId: string): Promise<void> {
  const item = attachments.get(messageId);
  // Cancelled (or already sent) while it waited its turn.
  if (!item || item.control) return;
  const { deps } = item;
  const id = messageId.slice(0, 8);
  const control = new AbortController();
  item.control = control;
  try {
    const gate = await deps.gate();
    if (control.signal.aborted || attachments.get(messageId) !== item) return;
    if (gate.kind === 'refused') {
      if (gate.reason === 'session-ended') {
        // The account that drew this row has left: nothing of it may go out under the next.
        deps.log(`[MEDIA] ${id}… dropped: the session ended while its salon was loading`);
        forget(item);
        deps.withdraw();
        return;
      }
      deps.log(`[MEDIA] ${id}… NOT uploaded: its salon cannot be loaded (reason=${gate.reason})`);
      park(item, 'error');
      deps.refused(deps.describe({ kind: 'gate', reason: gate.reason }));
      return;
    }
    item.attempts += 1;
    patchUpload(messageId, { phase: 'preparing', loaded: 0, total: 0, attempt: item.attempts });
    let ref: MediaRef;
    try {
      ref = await deps.upload(item.file, {
        signal: control.signal,
        onProgress: ({ loaded, total }) => {
          // A late event of an abandoned transfer must not redraw a view `forget` removed.
          if (control.signal.aborted) return;
          patchUpload(messageId, { phase: 'uploading', loaded, total });
        },
      });
    } catch (error) {
      if (error instanceof UploadAbortedError || control.signal.aborted) {
        deps.log(`[MEDIA] ${id}… upload aborted (${String(control.signal.reason ?? 'cancel')})`);
        return;
      }
      settleUploadFailure(item, error);
      return;
    }
    if (attachments.get(messageId) !== item) {
      // Cancelled as the last byte landed: the blob is the server's to expire, nothing is sent.
      deps.log(`[MEDIA] ${id}… uploaded after its cancel - not sent`);
      return;
    }
    const prepared = buildMediaMessage({ id: messageId, sentAt: item.sentAt }, item.media, {
      mediaId: ref.mediaId,
      key: ref.key,
      iv: ref.iv,
      ...(ref.encoding ? { encoding: ref.encoding } : {}),
    });
    // From here the salon send machinery owns the row (its Retry and Discard): this module lets go
    // BEFORE the swap, so the bubble never offers two retries for one message.
    forget(item);
    deps.showContent(prepared.content);
    deps.log(`[MEDIA] ${id}… uploaded as ${ref.mediaId.slice(0, 8)}…, handed to the salon send`);
    const refusal = await deps.deliver(prepared.proto);
    if (refusal) deps.refused(refusal);
  } catch (error) {
    // Nothing above is expected to throw past its own catch: a throw here is a defect, said loudly,
    // and the row keeps its Retry rather than spinning for ever.
    console.error(`[MEDIA] ${id}… salon attachment attempt threw unexpectedly:`, error);
    if (attachments.get(messageId) === item) park(item, 'error');
  } finally {
    item.control = null;
  }
}

/**
 * An upload that did not complete, classified at its throw: no answer while offline is owed to the
 * reconnect; no answer while online is `stalled` (nothing moved, Retry offered); an ANSWER - a
 * status - is `refused` with the server's reason on the banner; anything else is a local `error`.
 */
function settleUploadFailure(item: Attachment, error: unknown): void {
  const { deps, messageId } = item;
  const id = messageId.slice(0, 8);
  const status = refusalStatus(error);
  const noAnswer =
    status === null &&
    (error instanceof UploadNetworkError ||
      error instanceof UploadStalledError ||
      isTransportFailure(error));
  if (noAnswer && deps.isOffline()) {
    deps.log(
      `[MEDIA] ${id}… no answer and the device is offline - uploaded again on the reconnect`
    );
    park(item, 'waiting');
    oweSalonWrite(owedKey(messageId), async () => {
      if (!attachments.has(messageId)) return;
      patchUpload(messageId, { phase: 'queued', loaded: 0, total: 0 });
      enqueue(item);
    });
    return;
  }
  if (noAnswer) {
    deps.log(`[MEDIA] ${id}… the upload got no answer with the link up: ${String(error)}`);
    park(item, 'stalled');
    return;
  }
  if (status !== null) {
    deps.log(`[MEDIA] ${id}… upload refused (status=${status}): ${String(error)}`);
    park(item, 'refused');
    deps.refused(deps.describe({ kind: 'upload', status, error }));
    return;
  }
  console.error(`[MEDIA] ${id}… upload failed on this device:`, error);
  deps.log(`[MEDIA] ${id}… upload failed on this device: ${String(error)}`);
  park(item, 'error');
  deps.refused(deps.describe({ kind: 'upload', status: null, error }));
}
