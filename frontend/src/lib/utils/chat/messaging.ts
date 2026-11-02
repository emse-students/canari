import type { IMlsService } from '$lib/mlsService';
import type { ChatMessage, Conversation } from '$lib/types';
import type { OutboxEntry } from '$lib/db';
import {
  cancelOutboxMessage,
  enqueueOutboxMessage,
  getOutbox,
  onOutboxRegistered,
  OutboxEnqueueError,
  type LatestWins,
} from './outbox';
import {
  decodeAppMessage,
  encodeAppMessage,
  mkText,
  mkReply,
  mkReaction,
  mkSystem,
} from '$lib/proto/codec';
import { serializeEnvelope, mkTextEnvelope, parseEnvelope } from '$lib/envelope';
import {
  sendEncryptedChannelMessage,
  isChannelConversationId,
} from '$lib/utils/chat/channelCrypto';
import { extractMentionUserIds } from '$lib/utils/mentions';
import { notifyReaction } from '$lib/utils/chat/reactionNotify';
import { m } from '$lib/paraglide/messages';
import { cutReplyPreview, gifPreviewUrl } from '$lib/utils/chat/messageDisplay';
import { describeApiRefusal, refusalCode, refusalStatus } from '$lib/utils/apiRefusal';
import { GraineSealUnavailableError } from '$lib/utils/graine/sealUnavailable';
import {
  salonGateRefusalMessage,
  sealUnavailableMessage,
} from '$lib/utils/graine/sealUnavailableMessage';
import {
  currentSalonSession,
  isCurrentSalonSession,
  readSalonSendGate,
  whenSalonSendable,
} from '$lib/utils/graine/salonSendGate';
import type { SalonEchoChange } from './salonEcho';
import {
  clearUnsentSalonText,
  recordUnsentSalonText,
  takeOrphanedSalonTexts,
  type UnsentSalonText,
} from './salonUnsent';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { isTransportFailure } from '$lib/utils/transportFailure';
import { forgetOwedSalonWrite, oweSalonWrite } from './salonOwed';
import { salonRepeatIsSafe, whenSalonRepeatIsSafe } from './salonRepeatProof';
import { CHANNEL_MESSAGE_DELETED } from '$lib/services/ChannelService';
import { flushDmReadMarks } from './salonReadMarkQueue';
import { MessagePairWriteError, MessageWrittenError } from './messageWrittenError';
import { readWatermarkFrameData, readWatermarkFrameMark } from './readState';

/**
 * Dependencies required by message-sending helpers.
 * Passed as a single object to avoid long argument lists and make unit testing easier.
 */
export interface SendMessageDeps {
  userId: string;
  conversation: Conversation;
  /**
   * Shows (and, unless told otherwise, stores) a message. Calls `onPairWritten` when the message
   * and its `outboxEntry` reached disk in one write; a failed pair write THROWS
   * `MessagePairWriteError`; with no storage, neither.
   */
  addMessageToChat: (
    senderId: string,
    content: string,
    contactName: string,
    options: {
      replyTo?: ChatMessage['replyTo'];
      isSystem?: boolean;
      messageId?: string;
      timestamp?: Date;
      status?: ChatMessage['status'];
      skipDbSave?: boolean;
      /** Written in the same transaction as the message - see `AddMessageToChatOptions`. */
      outboxEntry?: OutboxEntry;
      /** The pair reached disk - see `AddMessageToChatOptions`. */
      onPairWritten?: () => void;
      /** A salon echo, shown before the server has a row - see `AddMessageToChatOptions`. */
      salonEcho?: boolean;
    }
  ) => Promise<void>;
  /** Moves a salon echo along (in flight, failed, settled) - see `salonEcho.ts`. */
  patchSalonEcho: (conversationKey: string, messageId: string, change: SalonEchoChange) => void;
  log: (msg: string) => void;
}

/**
 * A salon message that has been shown but not (yet) accepted by the server, kept so the failed row's
 * "retry" re-sends EXACTLY what the first attempt carried: same payload, same client id, same
 * mentions. Memory only; its durable half is the unsent ledger (`salonUnsent.ts`), from which the
 * next page life rebuilds it (`resumeUnsentSalonSends`).
 */
interface SalonSend {
  /** The text as typed: what the unsent ledger keeps for a kill or reload (`salonUnsent.ts`). */
  text: string;
  conversationKey: string;
  channelId: string;
  payload: Uint8Array;
  mentionedUserIds: string[];
  /** The echo writer and logger of the last attempt: what a re-send on the reconnect reuses. */
  deps: SendMessageDeps;
}
const salonSends = new Map<string, SalonSend>();

/** The key a send is owed to the reconnect under (`salonOwed.ts`). */
const sendKey = (messageId: string) => `send:${messageId}`;

/**
 * Owes a send that met NO ANSWER while this device was offline, or was held because it was, to the
 * next reconnect (`salonOwed.ts`), where it goes again under the same client id.
 */
function oweOnReconnect(messageId: string): void {
  oweSalonWrite(sendKey(messageId), async () => {
    const send = salonSends.get(messageId);
    if (!send) {
      // Settled meanwhile by the frame or a history page, or given up by its author.
      console.debug(`[SEND] owed salon send ${messageId.slice(0, 8)}... no longer registered`);
      return;
    }
    if (retrying.has(messageId)) {
      send.deps.log(`[SEND] owed salon send ${messageId.slice(0, 8)}... already being retried`);
      return;
    }
    retrying.add(messageId);
    try {
      await deliverSalonSend(messageId, send);
    } finally {
      retrying.delete(messageId);
    }
  });
}

/**
 * Sends whose first POST may have landed, waiting for an answer to prove this server answers a repeat
 * with its row (`salonRepeatProof.ts`) - each with the function that stops its wait.
 */
const awaitingRepeatProof = new Map<string, () => void>();

/**
 * Holds a send whose outcome is UNKNOWN until a repeat is proven safe, instead of repeating it
 * unasked: against a server without migration 090 the repeat would post it twice. Its row stays
 * `unconfirmed`, so the author's Retry is offered meanwhile; once an answer proves it, the send goes
 * again under its client id with no gesture.
 */
function awaitRepeatProof(messageId: string): void {
  if (awaitingRepeatProof.has(messageId)) return;
  const stop = whenSalonRepeatIsSafe(() => {
    awaitingRepeatProof.delete(messageId);
    const send = salonSends.get(messageId);
    if (!send) {
      console.debug(`[SEND] ${messageId.slice(0, 8)}... settled before a repeat was proven safe`);
      return;
    }
    if (retrying.has(messageId)) {
      send.deps.log(`[SEND] ${messageId.slice(0, 8)}... repeat proven safe, a retry is in flight`);
      return;
    }
    send.deps.log(
      `[SEND] ${messageId.slice(0, 8)}... repeat proven safe: sent again under its client id`
    );
    retrying.add(messageId);
    void deliverSalonSend(messageId, send).finally(() => retrying.delete(messageId));
  });
  awaitingRepeatProof.set(messageId, stop);
}

/** Stops a send's wait for the repeat proof: it was settled, retried by hand or given up. */
function stopAwaitingRepeatProof(messageId: string): void {
  awaitingRepeatProof.get(messageId)?.();
  awaitingRepeatProof.delete(messageId);
}

/** Ledger entries this page life took back and is waiting to send again (`resumeUnsentSalonSends`). */
const resumingSalonSends = new Set<string>();

/** The message ids this page life is still sending or can retry - what is NOT an orphan of a past life. */
export function liveSalonSendIds(): ReadonlySet<string> {
  return new Set([...salonSends.keys(), ...resumingSalonSends]);
}

/**
 * POSTs one salon send and moves its echo: `pending` while the salon is not loaded yet or the device
 * is offline, `sending` while in flight, `settled` on the server's answer, `error` on a refusal (the
 * entry stays registered so the row can be retried).
 *
 * A SALON NOT YET LOADED HOLDS THE SEND, IT DOES NOT REFUSE IT (2026-10-13). A salon is drawn from
 * the local store before the community listing has taught this session its scope, and the seal
 * used to throw `GraineUnknownChannelError` for a message typed in that window - nothing lost but
 * the order. The gate (`salonSendGate.ts`) is asked FIRST, so that fact is read where it is known
 * instead of learnt from the seal's refusal: the row stays `pending` until the salon is entered,
 * then goes through the ordinary seal - sealed and signed THEN, never queued unsealed. A listing
 * that ends without the salon, a community that leaves, a sign-out: each refuses the hold, and the
 * row turns `error` with its Retry. The wait is bounded by those events, never by a clock.
 *
 * AN OFFLINE DEVICE HOLDS THE SEND TOO (WP-OFF-3): nothing it POSTs can arrive, and a seal made now
 * spends a key index for nothing. The row stays `pending` and the send is owed to the next
 * reconnect, where it is sealed and posted.
 *
 * THE OUTCOME IS CLASSIFIED AT THE THROW. A status code below 500 is an ANSWER: the server saw the
 * request and said no, so the row is `error`. Anything else is an UNKNOWN outcome - the server may
 * hold the message - and since the server answers a repeat of the same client id with the row it
 * already holds (migration 090), sending it again is safe:
 * - a transport failure that left the device offline is OWED to the reconnect (`pending`), which
 *   re-delivers it with no gesture - once an answer has proven this server answers a repeat with
 *   its row (`salonRepeatProof.ts`); before that it is `unconfirmed` and waits for that proof;
 * - a repeat of a message deleted since it landed is refused (410 `CHANNEL_MESSAGE_DELETED`): the
 *   send is forgotten and its row removed;
 * - anything else (a 5xx, no answer while the link still works, a throw with no status) is
 *   `unconfirmed`: nothing known will change the answer, so it waits for the author's Retry.
 * The broadcast frame or the next history page still settle the row first whenever the first POST
 * did land. No clock decides any of it.
 *
 * @returns `null` when nothing needs saying (sent, or held for the reconnect), else the
 *   member-facing sentence.
 */
async function deliverSalonSend(messageId: string, send: SalonSend): Promise<string | null> {
  const { deps } = send;
  const reading = readSalonSendGate(send.channelId);
  if (reading.kind === 'wait') {
    deps.log(
      `[SEND] channel send ${messageId.slice(0, 8)}... HELD: salon ${send.channelId.slice(0, 8)} is not loaded on this device yet`
    );
    deps.patchSalonEcho(send.conversationKey, messageId, { kind: 'state', status: 'pending' });
  }
  const gate = reading.kind === 'wait' ? await whenSalonSendable(send.channelId) : reading;
  if (gate.kind === 'refused') {
    // NOTHING WAS SEALED: an answer, so the row is `error` and its Retry is safe.
    deps.log(
      `[SEND] channel send ${messageId.slice(0, 8)}... NOT sent: salon ${send.channelId.slice(0, 8)} cannot be loaded (reason=${gate.reason})`
    );
    deps.patchSalonEcho(send.conversationKey, messageId, { kind: 'state', status: 'error' });
    return salonGateRefusalMessage(gate.reason);
  }
  if (reading.kind === 'wait') {
    deps.log(`[SEND] channel send ${messageId.slice(0, 8)}... released: its salon is loaded`);
  }
  if (connectivity.isOffline) {
    deps.log(
      `[SEND] channel send ${messageId.slice(0, 8)}... HELD: this device is offline - sent on the reconnect`
    );
    deps.patchSalonEcho(send.conversationKey, messageId, { kind: 'state', status: 'pending' });
    oweOnReconnect(messageId);
    return null;
  }
  deps.patchSalonEcho(send.conversationKey, messageId, { kind: 'state', status: 'sending' });
  try {
    const row = await sendEncryptedChannelMessage(
      send.channelId,
      send.payload,
      messageId,
      undefined,
      send.mentionedUserIds
    );
    salonSends.delete(messageId);
    stopAwaitingRepeatProof(messageId);
    clearUnsentSalonText(deps.userId, messageId);
    deps.patchSalonEcho(send.conversationKey, messageId, {
      kind: 'settled',
      serverId: row?.id ?? null,
      serverMs: row?.serverMs,
    });
    return null;
  } catch (error: unknown) {
    // THE ONLY ONE OF THE PARKED SEND SITES THAT CARRIES AN HTTP STATUS, which is why it is the
    // only one this helper can close. `ChannelService.handleError` throws `ChannelApiError(status,
    // code, text)` where `text` is the SERVER'S OWN BODY - dev-facing English, correctly so for a
    // log - and this catch used to interpolate it straight into a French sentence. The other six
    // sites wrap work that performs no HTTP request at the point of the throw (the outbox, the
    // MLS layer, a forward whose inner call already caught its own refusal), so they need a code
    // at the throw rather than this.
    //
    // `describeApiRefusal` answers `null` for a status it has nothing better to say about, and
    // that is not a fallback path: it is the designed answer, and what replaces it here is a
    // generic line of OUR OWN rather than the prose that crossed the network.
    //
    // `String(error)` rather than the usual `instanceof Error ? error.message` ternary, because
    // that ternary is the exact shape `serverProse.test.ts` reads as a site rendering the
    // server's words and a regex cannot see that this one only reaches a log. It does NOT make
    // this tree joinable: over twenty files under `src/lib/utils` use the ternary for logs, so
    // that guard cannot own this directory until it can tell a log from a render - measured
    // 2026-09-15, see docs/wiki/backlog.md.
    // A SEAL THIS DEVICE COULD NOT MAKE IS NAMED BY ITS TYPED REASON: nothing left the device,
    // there is no status, and the generic line below hid which of six facts was missing.
    if (error instanceof GraineSealUnavailableError) {
      deps.log(
        `[SEND] channel send ${messageId.slice(0, 8)}… not sealed (reason=${error.reason}): ${String(error)}`
      );
      deps.patchSalonEcho(send.conversationKey, messageId, { kind: 'state', status: 'error' });
      return sealUnavailableMessage(error.reason);
    }
    const status = refusalStatus(error);
    // NO ANSWER, AND THE LINK IS DOWN: the reconnect is the event that changes the answer, so the
    // send is owed to it. `isOffline` was set by this very failure (`trackedFetch` reports every
    // transport failure to the store before it rethrows), so it is a fact, not a guess.
    if (status === null && isTransportFailure(error) && connectivity.isOffline) {
      // ...unless the POST may have landed on a server that would post a repeat twice: then nothing
      // known makes the repeat safe until an answer proves it (`salonRepeatProof.ts`).
      if (!salonRepeatIsSafe()) {
        deps.log(
          `[SEND] channel send ${messageId.slice(0, 8)}… OUTCOME UNKNOWN, offline: unconfirmed until an answer proves a repeat is answered with its row: ${String(error)}`
        );
        deps.patchSalonEcho(send.conversationKey, messageId, {
          kind: 'state',
          status: 'unconfirmed',
        });
        awaitRepeatProof(messageId);
        return m.chat_send_unconfirmed();
      }
      deps.log(
        `[SEND] channel send ${messageId.slice(0, 8)}… got no answer and the device is offline - sent again, same client id, on the reconnect: ${String(error)}`
      );
      deps.patchSalonEcho(send.conversationKey, messageId, { kind: 'state', status: 'pending' });
      oweOnReconnect(messageId);
      return null;
    }
    // NO ANSWER WITH THE LINK UP, OR A GATEWAY'S 5xx, IS NOT A REFUSAL. The request may have reached
    // the server (a 502/504 may come from a proxy AFTER the social service stored the row), and no
    // event is known to change the answer, so the row is `unconfirmed` and its Retry - the author's
    // gesture - repeats it under the same client id. A server carrying migration 090 answers that
    // with its stored row; an older one posts it again, so the log says which one this page knows.
    if (status === null || status >= 500) {
      deps.log(
        `[SEND] channel send ${messageId.slice(0, 8)}… OUTCOME UNKNOWN (status=${status ?? 'none'}): unconfirmed, its Retry repeats it under the same client id - ${
          salonRepeatIsSafe()
            ? 'this server has echoed a client id, so it answers a repeat with its row'
            : 'NOT proven safe: a server without migration 090 would post it a second time'
        }: ${String(error)}`
      );
      deps.patchSalonEcho(send.conversationKey, messageId, {
        kind: 'state',
        status: 'unconfirmed',
      });
      return m.chat_send_unconfirmed();
    }
    // A REPEAT OF A MESSAGE DELETED SINCE ITS FIRST SEND LANDED (migration 090's tombstone): it was
    // posted, then removed by its author or a moderator. Nothing is left to send or to offer again.
    if (refusalCode(error) === CHANNEL_MESSAGE_DELETED) {
      deps.log(
        `[SEND] channel send ${messageId.slice(0, 8)}… was DELETED after it landed: forgotten, its row removed`
      );
      salonSends.delete(messageId);
      stopAwaitingRepeatProof(messageId);
      clearUnsentSalonText(deps.userId, messageId);
      deps.patchSalonEcho(send.conversationKey, messageId, { kind: 'gone' });
      return null;
    }
    deps.log(
      `[SEND] channel send ${messageId.slice(0, 8)}… refused (status=${status}): ${String(error)}`
    );
    deps.patchSalonEcho(send.conversationKey, messageId, { kind: 'state', status: 'error' });
    return (
      describeApiRefusal(status, m.channel_action_message_send()) ?? m.chat_send_error_generic()
    );
  }
}

/** Rows whose retry is on the wire: a second click while one is in flight is refused, not sent. */
const retrying = new Set<string>();

/**
 * Re-sends a salon message from its row's "retry". Same payload, same client id.
 *
 * SAFE WHATEVER THE FIRST ATTEMPT DID: after a refusal (`error`) the server stored nothing, and after
 * an unknown outcome (`unconfirmed`) it answers the repeat with the row it already holds (migration
 * 090, WP-OFF-3). A retry of a salon that could not be loaded waits for it again if a listing is in
 * flight.
 *
 * @returns the refusal sentence when it failed again, `null` when the server took it, and
 *   `undefined` when nothing is registered under `messageId` (a reload, or already sent).
 */
export async function retrySalonSend(
  messageId: string,
  deps: SendMessageDeps
): Promise<string | null | undefined> {
  const send = salonSends.get(messageId);
  if (!send) {
    deps.log(`[SEND] retry ${messageId.slice(0, 8)}…: no salon send registered`);
    return undefined;
  }
  if (retrying.has(messageId)) {
    deps.log(`[SEND] retry ${messageId.slice(0, 8)}…: one is already in flight - ignored`);
    return undefined;
  }
  retrying.add(messageId);
  // The author's gesture IS the delivery: nothing stays owed to the reconnect beside it.
  forgetOwedSalonWrite(sendKey(messageId));
  stopAwaitingRepeatProof(messageId);
  deps.log(`[SEND] retrying salon message ${messageId.slice(0, 8)}…`);
  try {
    send.deps = deps;
    return await deliverSalonSend(messageId, send);
  } finally {
    retrying.delete(messageId);
  }
}

/**
 * Gives an unconfirmed salon send back to its author: forgets it and returns its text for the
 * composer (WP-OFF-1's draft restore), or `null` when nothing is registered under `messageId`.
 */
export function takeBackSalonSend(messageId: string, userId: string): string | null {
  const send = salonSends.get(messageId);
  if (!send) return null;
  discardSalonSend(messageId, userId);
  return send.text;
}

/**
 * Forgets a salon send another tab PROVED delivered (its `message_added` carried this client id):
 * nothing is left to retry or to hand back.
 */
export function forgetDeliveredSalonSend(messageId: string, userId: string): void {
  stopAwaitingRepeatProof(messageId);
  if (salonSends.delete(messageId)) clearUnsentSalonText(userId, messageId);
}

/**
 * Forgets every salon send of the session that ended, in memory only: what is still unanswered stays
 * in that account's unsent ledger, and its next session sends it again (`resumeUnsentSalonSends`) -
 * which it could not while this page life still counted them as live.
 */
export function forgetSalonSendsOfEndedSession(): void {
  if (salonSends.size > 0) {
    console.log(
      `[SEND] signed out: ${salonSends.size} salon send(s) left to the ledger for the next session`
    );
  }
  salonSends.clear();
  for (const stop of awaitingRepeatProof.values()) stop();
  awaitingRepeatProof.clear();
  // A resume still waiting on its salon's gate re-checks the session itself (`resumeOrphans`); its
  // entries stay in the ledger, so the next session of THAT account takes them.
  resumingSalonSends.clear();
}

/** Forgets a failed salon send the member discarded: its row is removed by the caller. */
export function discardSalonSend(messageId: string, userId: string): void {
  salonSends.delete(messageId);
  forgetOwedSalonWrite(sendKey(messageId));
  stopAwaitingRepeatProof(messageId);
  clearUnsentSalonText(userId, messageId);
}

/** A salon message the unsent ledger can send again: one written with its `sentAt`. */
type QueuedSalonText = UnsentSalonText & { sentAt: number };

/**
 * The payload of a salon text, rebuilt identically from what the ledger keeps: the same client id and
 * author clock are sealed inside, so a repeat is the same message for every reader.
 */
function salonTextPayload(entry: QueuedSalonText): Uint8Array {
  const { messageId, sentAt, text, replyTo } = entry;
  return replyTo
    ? encodeAppMessage({ ...mkReply(text, replyTo), messageId, sentAt })
    : encodeAppMessage({ ...mkText(text), messageId, sentAt });
}

/**
 * Draws a salon text's echo, records it in the unsent ledger, and delivers it - the one path for a
 * fresh send and for one a past page life left unanswered (`resumeUnsentSalonSends`), so the two
 * cannot differ in what they seal or what they keep.
 *
 * `echoed: false` means no row could be drawn, nothing was recorded and nothing was sent: the caller
 * still holds the text.
 *
 * `mayHaveLanded` marks a send a past page life may already have POSTed: it goes at once only when a
 * repeat is proven safe (`salonRepeatProof.ts`); until then its row is `unconfirmed`, with its Retry.
 */
async function queueSalonSend(
  entry: QueuedSalonText,
  deps: SendMessageDeps,
  mayHaveLanded = false
): Promise<{ echoed: false } | { echoed: true; refusal: string | null }> {
  const { messageId, conversationKey, text, sentAt, replyTo } = entry;
  const send: SalonSend = {
    text,
    conversationKey,
    channelId: conversationKey.replace(/^channel_/, ''),
    payload: salonTextPayload(entry),
    // Cleartext mention targets let the server route the `mentions` notification level.
    mentionedUserIds: extractMentionUserIds(text),
    deps,
  };
  const echoReply: ChatMessage['replyTo'] = replyTo
    ? { id: replyTo.id, senderId: replyTo.senderId, content: replyTo.preview }
    : undefined;
  try {
    await deps.addMessageToChat(
      deps.userId,
      serializeEnvelope(mkTextEnvelope(text, echoReply)),
      conversationKey,
      {
        messageId,
        status: 'pending',
        timestamp: new Date(sentAt),
        skipDbSave: true,
        salonEcho: true,
        ...(echoReply ? { replyTo: echoReply } : {}),
      }
    );
  } catch (error: unknown) {
    deps.log(
      `[SEND] salon echo of ${messageId.slice(0, 8)}... could not be shown: ${String(error)}`
    );
    return { echoed: false };
  }
  salonSends.set(messageId, send);
  // Before the POST leaves: a kill from here on sends it again at the next start.
  recordUnsentSalonText(deps.userId, entry);
  // From here the message is in the ledger: a throw is about a message that EXISTS, typed so no
  // caller sends it again.
  try {
    if (mayHaveLanded && !salonRepeatIsSafe()) {
      deps.log(
        `[SEND] unanswered salon message ${messageId.slice(0, 8)}... NOT sent again yet: no answer has proven this server answers a repeat with its row - unconfirmed, its Retry offered`
      );
      deps.patchSalonEcho(conversationKey, messageId, { kind: 'state', status: 'unconfirmed' });
      awaitRepeatProof(messageId);
      return { echoed: true, refusal: null };
    }
    return { echoed: true, refusal: await deliverSalonSend(messageId, send) };
  } catch (e) {
    throw new MessageWrittenError(messageId, e);
  }
}

/** The tail of the resumes in flight - see `resumeUnsentSalonSends`. */
let resumeTail: Promise<unknown> = Promise.resolve();

/**
 * Sends again what a PAST page life left unanswered in the unsent ledger (WP-OFF-3), under the same
 * client id - the server answers a repeat with the row it holds, so a message that did arrive is not
 * posted twice. That holds only on a server carrying migration 090, so each entry is drawn
 * `unconfirmed` and waits until an answer has proven it (`salonRepeatProof.ts`). Only entries whose
 * writer is PROVEN dead are taken (`takeOrphanedSalonTexts`), and one whose session ends while it
 * waits stays in its account's ledger.
 *
 * `conversationKey` narrows it to one salon (the one just opened); `null` takes every salon's, which
 * the session runs once it is up. An entry's echo needs its salon's conversation, which the listing
 * draws: each entry first waits for its salon's send gate (an event, never a clock), and one whose
 * conversation is still absent is put back, owned by this page life, for the moment its salon opens.
 *
 * @returns the entries this build cannot rebuild as composed (written before `sentAt` was kept) - the
 *   caller hands their text back to the composer, as before WP-OFF-3.
 */
export function resumeUnsentSalonSends(
  userId: string,
  depsFor: (conversationKey: string) => SendMessageDeps | null,
  conversationKey: string | null
): Promise<UnsentSalonText[]> {
  // ONE TAKE AT A TIME: the session's resume and a salon opened at the same instant would both read
  // the ledger before either marked an entry live, and draw it twice.
  const run = resumeTail.then(() => resumeOrphans(userId, depsFor, conversationKey));
  resumeTail = run.catch(() => undefined);
  return run;
}

async function resumeOrphans(
  userId: string,
  depsFor: (conversationKey: string) => SendMessageDeps | null,
  conversationKey: string | null
): Promise<UnsentSalonText[]> {
  const session = currentSalonSession();
  const orphans = await takeOrphanedSalonTexts(userId, conversationKey, liveSalonSendIds());
  if (orphans.length === 0) return [];
  const legacy = orphans.filter((o) => typeof o.sentAt !== 'number');
  const resumable = orphans.filter((o): o is QueuedSalonText => typeof o.sentAt === 'number');
  console.log(
    `[SEND] ${orphans.length} unanswered salon message(s) of a past page life: ${resumable.length} sent again, ${legacy.length} back to the composer`
  );
  // Owned by this page life from now on, so a sibling tab does not take them while they wait, and
  // LIVE in it, so a second resume (the salon opened meanwhile) does not take them twice.
  for (const o of resumable) {
    recordUnsentSalonText(userId, o);
    resumingSalonSends.add(o.messageId);
  }
  void Promise.all(
    resumable.map(async (entry) => {
      try {
        const gate = await whenSalonSendable(entry.conversationKey.replace(/^channel_/, ''));
        // THE SESSION THAT TOOK IT MAY HAVE ENDED during the wait: the conversation map is not
        // cleared yet, and what would seal it is the NEXT account's session. It stays in this
        // account's ledger, for its next session.
        if (!isCurrentSalonSession(session)) {
          console.log(
            `[SEND] unanswered salon message ${entry.messageId.slice(0, 8)}... kept in the ledger: its session ended while it waited (gate=${gate.kind})`
          );
          return;
        }
        const deps = depsFor(entry.conversationKey);
        if (!deps) {
          console.warn(
            `[SEND] unanswered salon message ${entry.messageId.slice(0, 8)}... kept for later: its salon has no conversation here (gate=${gate.kind})`
          );
          return;
        }
        deps.log(
          `[SEND] unanswered salon message ${entry.messageId.slice(0, 8)}... of a past page life drawn again under its client id`
        );
        const queued = await queueSalonSend(entry, deps, true);
        if (!queued.echoed) {
          console.error(
            `[SEND] unanswered salon message ${entry.messageId.slice(0, 8)}... not resumed: its row could not be drawn - kept in the ledger`
          );
        }
      } finally {
        // Registered in `salonSends` by now, or left in the ledger for the salon's next opening.
        resumingSalonSends.delete(entry.messageId);
      }
    })
  ).catch((e: unknown) => console.error(`[SEND] resuming unanswered salon messages failed:`, e));
  return legacy;
}

/**
 * Sends a text message in a conversation, optionally as a reply to a previous message.
 *
 * For direct/group MLS conversations the message is captured into the persistent outbox and
 * displayed optimistically with status `'pending'`; the outbox flusher encrypts and delivers it
 * as soon as the group is sendable (now, on reconnect, or after a Welcome),
 * surviving reload/kill. The user never sees a transient "send failed" error - the only hard
 * block is a conversation whose group was deleted server-side (`deletedRemotely`).
 *
 * For channel conversations (`contactName` starts with `'channel_'`) the message is shown as an echo
 * and queued in the unsent ledger, then posted by `deliverSalonSend` - held while its salon is not
 * loaded or the device is offline, and sent again by the next page life if this one dies first
 * (`queueSalonSend`, WP-OFF-3).
 *
 * Returns `{ success: false }` silently when the text is empty.
 */
export async function sendChatMessage(
  text: string,
  contactName: string,
  replyingTo: ChatMessage | null,
  deps: SendMessageDeps
): Promise<{ success: boolean; error?: string; echoed?: boolean; messageId?: string }> {
  const { userId, conversation, addMessageToChat } = deps;

  deps.log(
    `[SEND] sendChatMessage: contact=${JSON.stringify(contactName)} groupId="${conversation.id}" lifecycle=${conversation.lifecycle} chars=${text.length} reply=${!!replyingTo}`
  );

  if (!text.trim()) {
    deps.log('[SEND] Abort: empty text');
    return { success: false };
  }

  const messageId = crypto.randomUUID();
  const sentAt = Date.now();

  // Reply preview (from the quoted message envelope), shared by the proto and the local echo.
  let replyToData: ChatMessage['replyTo'] = undefined;
  if (replyingTo) {
    const replyEnv = parseEnvelope(replyingTo.content);
    const replyPreview =
      replyEnv.kind === 'text' && gifPreviewUrl(replyEnv.text)
        ? // A GIF quote keeps its WHOLE address: cut at 100 characters it is a broken picture.
          replyEnv.text.trim()
        : replyEnv.kind === 'text' || replyEnv.kind === 'system'
          ? cutReplyPreview(replyEnv.text)
          : replyEnv.kind === 'media'
            ? replyEnv.caption === undefined
              ? m.chat_preview_media()
              : cutReplyPreview(replyEnv.caption)
            : cutReplyPreview(`${m.chat_preview_poll()} ${replyEnv.question}`);
    replyToData = { id: replyingTo.id, senderId: replyingTo.senderId, content: replyPreview };
  }

  // Channels: the text is SHOWN at once, as a local echo the server's answer settles, and it is
  // queued durably in the unsent ledger, so neither a refusal nor a kill can make it vanish.
  if (isChannelConversationId(contactName)) {
    const queued = await queueSalonSend(
      {
        messageId,
        conversationKey: contactName,
        text,
        sentAt,
        ...(replyToData
          ? {
              replyTo: {
                id: replyToData.id,
                senderId: replyToData.senderId,
                preview: replyToData.content,
              },
            }
          : {}),
      },
      deps
    );
    if (!queued.echoed) return { success: false, error: m.chat_send_error_generic() };
    // `echoed`: the text lives in a row now (failed, with its retry), so the composer keeps nothing.
    return queued.refusal === null
      ? { success: true, echoed: true }
      : { success: false, error: queued.refusal, echoed: true };
  }

  // Group deleted/excluded server-side: the only hard block (deletion banner is shown).
  if (conversation.lifecycle === 'removed') {
    return { success: false, error: m.chat_conversation_deleted_message() };
  }

  // A quote from inside a member's exclusion window is decided by the OUTBOX, at the send - not here,
  // where it would cost a round trip per reply and turn an offline compose into a lost quote. See
  // `decideQuote` in `outbox.ts`.

  // THE ECHO AND ITS QUEUE ENTRY ARE ONE WRITE, and the entry is therefore built first.
  //
  // It used to be two awaits in the other order - persist the echo, then queue it - and a document
  // torn down between them left a `pending` message on disk that no queue knew about: never sent,
  // never retried, never reported, and visible to its author for ever. TAB-5 reloads 15 ms after
  // the click and reproduced it on 2026-09-05: the console showed `sendChatMessage` with no
  // `[OUTBOX] Queued` after it, the peer had nothing, the sender had the message.
  //
  // `alreadyDurable` below is exact rather than optimistic: it is what `addMessageToChat` REPORTS
  // it wrote (`onPairWritten`), never inferred. With no storage it wrote nothing and says so; a pair
  // write that failed is thrown typed (`MessagePairWriteError`), and the outbox then writes its own
  // row - the message still leaves (review of #2843, M1: it used to be swallowed, and the row was
  // marked durable when nothing was on disk).
  const entry: OutboxEntry = {
    id: messageId,
    conversationId: conversation.id,
    sentAt,
    kind: replyingTo ? 'reply' : 'text',
    text,
    ...(replyToData
      ? {
          replyTo: {
            id: replyToData.id,
            senderId: replyToData.senderId,
            preview: replyToData.content,
          },
        }
      : {}),
    status: 'pending',
    attempts: 0,
    createdAt: sentAt,
  };
  const envelope = serializeEnvelope(mkTextEnvelope(text, replyToData));
  let pairWritten = false;
  try {
    await addMessageToChat(userId, envelope, contactName, {
      messageId,
      status: 'pending',
      timestamp: new Date(sentAt),
      outboxEntry: entry,
      onPairWritten: () => {
        pairWritten = true;
      },
      ...(replyToData ? { replyTo: replyToData } : {}),
    });
  } catch (e) {
    if (!(e instanceof MessagePairWriteError)) throw e;
    // The entry reached disk alone (SQLite writes it first): the queue owns it already.
    pairWritten = e.entryWritten;
    deps.log(
      e.entryWritten
        ? `[SEND] ${messageId.slice(0, 8)}… its entry was written WITHOUT its echo - the queue sends it: ${String(e.cause)}`
        : `[SEND] ${messageId.slice(0, 8)}… its echo and entry were NOT written together - the outbox writes its own row: ${String(e.cause)}`
    );
  }
  // Written beside the echo: only the mirror and the flush are owed. Otherwise the outbox writes the
  // row. Either way it classifies its own failures at the throw: `MessageWrittenError` once the row
  // is on disk, `OutboxEnqueueError` before.
  await enqueueOutboxMessage(entry, pairWritten ? { alreadyDurable: true } : undefined);
  deps.log(`[SEND] ${messageId.slice(0, 8)}… queued (pending)`);
  return { success: true, messageId };
}

/** Minimal dependencies shared by reaction, edit, delete, and read-receipt helpers. */
interface MessageActionDeps {
  mlsService: IMlsService;
  userId: string;
  deviceKeyB64: string;
  conversation: Conversation;
  /** Display name of the current user - used as actor in reaction notifications. */
  currentUserDisplayName?: string;
}

/**
 * Captures a pre-encoded control AppMessage (reaction, edit, delete, pin, read receipt) into the
 * durable outbox instead of sending it fire-and-forget. The flusher delivers it (silent, retried
 * with backoff) as soon as the group is sendable, so control
 * events converge across peers even if the group was momentarily unsendable, or the app reloaded
 * or was killed before the original direct send could go through.
 *
 * @returns true when the queue took the event, false when it REFUSED (`OutboxEnqueueError`): the
 *          caller of a user-visible act (reaction, edit, pin, delete) surfaces that as a mention
 *          with Retry (`controlRefusals.svelte.ts`); the read watermark has no surface and only logs.
 */
async function enqueueControlEvent(
  kind: string,
  conversationId: string,
  proto: Uint8Array,
  latestWins?: LatestWins
): Promise<boolean> {
  try {
    await queueControlEvent(conversationId, proto, latestWins);
    return true;
  } catch (e) {
    // A control event is best-effort by nature (it converges on the next one), so a queue that cannot
    // take it must not throw into the reaction/edit/pin/read UI - but it is NEVER silent: the peers
    // will not hear of this event. Only the typed refusal is absorbed; anything else still throws.
    if (!(e instanceof OutboxEnqueueError)) throw e;
    console.error(
      `[OUTBOX] control event "${kind}" not queued, peers will not receive it: ${e.message}`
    );
    return false;
  }
}

/**
 * The control-event enqueue itself, which THROWS `OutboxEnqueueError` when the queue cannot take it -
 * for a caller that owns the event's durability (the owed DM read mark) and must know.
 */
function queueControlEvent(
  conversationId: string,
  proto: Uint8Array,
  latestWins?: LatestWins
): Promise<void> {
  const now = Date.now();
  return enqueueOutboxMessage(
    {
      id: crypto.randomUUID(),
      conversationId,
      sentAt: now,
      kind: 'control',
      controlProto: proto,
      status: 'pending',
      attempts: 0,
      createdAt: now,
    },
    latestWins ? { latestWins } : undefined
  );
}

/**
 * Sends an emoji reaction to a message via the durable outbox (MLS broadcast), and notifies the
 * message author via a server-side push if they are a different user. The reaction is captured
 * into the outbox so it converges on peers even if the group is momentarily unsendable.
 */
export async function addReaction(
  messageId: string,
  emoji: string,
  at: number,
  deps: MessageActionDeps
): Promise<boolean> {
  const { userId, conversation, currentUserDisplayName } = deps;

  const queued = await enqueueControlEvent(
    'reaction',
    conversation.id,
    encodeAppMessage(mkReaction(messageId, emoji, at))
  );
  // A refused reaction reaches nobody, so nobody is notified either.
  if (!queued) return false;

  // Notify the message author (fire-and-forget, non-fatal). The message's CONTENT is deliberately
  // not read here - see notifyReaction: the author's own devices hold it already.
  const targetMsg = conversation.messages.find((m) => m.id === messageId);
  if (targetMsg?.senderId && targetMsg.senderId !== userId) {
    void notifyReaction({
      groupId: conversation.id,
      targetSenderId: targetMsg.senderId,
      emoji,
      messageId,
      actorName: currentUserDisplayName ?? userId,
    }).catch(() => {});
  }
  return true;
}

/**
 * Takes an emoji reaction back, as the SAME frame that placed it with `removed` set.
 *
 * It used to be a `remove_reaction` system event carrying JSON, which left the two legs of one
 * operation with two shapes and nowhere to put the timestamp the merge needs on both. Peers still
 * accept the old event when replaying a stream written before this change - see
 * `docs/wiki/legacy-compatibility.md`.
 */
export async function removeReaction(
  messageId: string,
  emoji: string,
  at: number,
  deps: MessageActionDeps
): Promise<boolean> {
  return enqueueControlEvent(
    'reaction_remove',
    deps.conversation.id,
    encodeAppMessage(mkReaction(messageId, emoji, at, true))
  );
}
/**
 * Captures an "edit_message" system event in the durable outbox so all peers update the message
 * content in their local history.
 *
 * `editedAt` IS THE CALLER'S, for the same reason `setMessagePinned` takes its `at`: the local apply
 * and the broadcast are one act and must carry one instant. This read the clock itself, so the
 * sending device stored a timestamp a few milliseconds off the one it told everyone else - and once
 * that timestamp decides which of two concurrent edits wins, a device disagreeing with its own
 * broadcast is a device that can lose to itself.
 */
export async function editMessage(
  messageId: string,
  newContent: string,
  editedAt: number,
  deps: MessageActionDeps
): Promise<boolean> {
  return enqueueControlEvent(
    'edit_message',
    deps.conversation.id,
    encodeAppMessage(mkSystem('edit_message', JSON.stringify({ messageId, newContent, editedAt })))
  );
}

/**
 * What a delete actually did, which decides what the caller writes locally.
 *
 * `withdrawn` - the frame never left this device, so no peer has it and none ever will.
 * `broadcast` - the frame is out there and a `delete_message` event is on its way after it.
 * `refused` - the frame is out there and the queue REFUSED the `delete_message` event, so the peers
 *             will keep the message: the caller must NOT show it as deleted, and offers Retry.
 */
export type DeleteOutcome = 'withdrawn' | 'broadcast' | 'refused';

/**
 * Deletes a message: by WITHDRAWING it if it has not left this device, otherwise by broadcasting a
 * `delete_message` system event so peers that already have it remove it from their history.
 *
 * WHY THE WITHDRAWAL COMES FIRST. Both legs used to be ordinary outbox entries side by side, so
 * deleting a message composed offline SENT it and then took it back: the peer received the text,
 * rendered it, and only then received the tombstone. **The user deleted something that had never
 * been sent, and it was sent anyway.** Ordering the two entries could not fix that - the text still
 * goes out - so the queued entry is dropped instead, and the event is enqueued only when there is
 * nothing left to drop, which is precisely the case the event exists for.
 *
 * The two outcomes are one question answered where it is KNOWN rather than learnt by failing: only
 * the outbox can say whether the frame is still on this device, and it answers before either path
 * is taken.
 *
 * WHICH OUTCOME IT WAS IS RETURNED, because the caller's local write differs between them and it
 * cannot recompute the answer afterwards. It used to be dropped here, so the caller tombstoned in
 * both cases - and a withdrawn message left a "deleted message" row on the sender for something no
 * peer had ever received, which every reconciliation then read as a row the peers had LOST.
 */
export async function deleteMessage(
  messageId: string,
  deps: MessageActionDeps
): Promise<DeleteOutcome> {
  if (await cancelOutboxMessage(messageId)) return 'withdrawn';
  const queued = await enqueueControlEvent(
    'delete_message',
    deps.conversation.id,
    encodeAppMessage(mkSystem('delete_message', JSON.stringify({ messageId })))
  );
  return queued ? 'broadcast' : 'refused';
}

/**
 * Captures a "pin"/"unpin" system event in the durable outbox so all members converge.
 *
 * `at` is the sender's clock for this message's pin state, and both legs carry it for the same
 * reason a reaction's two legs do: the merge on the far side keeps the larger one, so an undated
 * leg could never be ordered against a dated one. It is the CALLER's `at`, not one taken here - the
 * optimistic local apply and the broadcast must state the same instant, or the sender's own device
 * disagrees with every peer about when it acted.
 */
export async function setMessagePinned(
  messageId: string,
  pinned: boolean,
  at: number,
  deps: MessageActionDeps
): Promise<boolean> {
  return enqueueControlEvent(
    pinned ? 'pin' : 'unpin',
    deps.conversation.id,
    encodeAppMessage(mkSystem(pinned ? 'pin' : 'unpin', JSON.stringify({ messageId, at })))
  );
}

/**
 * Captures a "read_watermark" system event in the durable outbox: *I have read this conversation
 * up to `at`*, one monotone instant rather than a list of message ids.
 *
 * `at` is drawn from the messages themselves (see `watermarkAfterReading`), never from the clock,
 * so it compares correctly against the population it will be compared against on every other
 * device.
 *
 * LATEST-WINS IN THE QUEUE: an unsent watermark of the same conversation is superseded by this one,
 * and this one is not queued when an unsent one already carries as much. Only the newest needs to
 * reach anyone, and each frame costs every member a decrypt and a checkpoint. See
 * history-reconciliation, "The sender says only what is new".
 *
 * @returns false only when there is nothing to announce (`at` not ahead of what peers were last
 *          told), which is what keeps an open conversation from emitting a frame per render.
 */
export async function sendReadWatermark(at: number, deps: MessageActionDeps): Promise<boolean> {
  if (!Number.isFinite(at) || at <= 0) return false;
  await enqueueControlEvent('read_watermark', deps.conversation.id, ...readWatermarkFrame(at));
  return true;
}

/**
 * The frame and its latest-wins key. `at` is on the SERVER's clock (`readMarkTarget`), and the frame
 * says so with `serverAt`; the same value rides as `at` for an older client (readState.ts).
 */
function readWatermarkFrame(at: number): [Uint8Array, LatestWins] {
  return [
    encodeAppMessage(mkSystem('read_watermark', JSON.stringify(readWatermarkFrameData(at)))),
    { value: at, valueOf: queuedReadWatermarkAt },
  ];
}

/**
 * Hands every DM and group read mark this user still OWES to the outbox, and drops each one only
 * once the outbox took it (`salonReadMarkQueue.ts`, the DM ledger). A mark is owed from the instant
 * it is decided, so a process killed inside the 2 s debounce leaves it here rather than nowhere.
 *
 * @returns how many marks the outbox took.
 */
export function flushOwedDmReadMarks(userId: string): Promise<number> {
  return flushDmReadMarks(userId, (conversationId, at, clock) => {
    if (!(Number.isFinite(at) && at > 0)) return Promise.resolve();
    // A mark owed from before 2026-10-31 is on the authors' `sentAt` clock: it leaves as the older
    // `{at}` frame, which every reader takes into its stamped map - never as `serverAt`.
    return clock === 'server'
      ? queueControlEvent(conversationId, ...readWatermarkFrame(at))
      : queueControlEvent(
          conversationId,
          encodeAppMessage(mkSystem('read_watermark', JSON.stringify({ at })))
        );
  });
}

/**
 * Drains the owed DM read marks now if an outbox is active, and again on every registration - the
 * boot and the sign-in being where a mark left by a killed process becomes deliverable. Never a timer:
 * the registration is the event that changes the answer.
 *
 * @returns the unsubscribe.
 */
export function drainOwedDmReadMarksOnOutbox(currentUserId: () => string | null): () => void {
  const drain = (userId: string, why: string) => {
    flushOwedDmReadMarks(userId)
      .then((n) => {
        if (n > 0) console.log(`[READ] ${n} owed DM read mark(s) handed to the outbox (${why})`);
      })
      .catch((e) => console.error(`[READ] owed DM read marks drain threw (${why}):`, e));
  };
  const userId = currentUserId();
  if (userId && getOutbox()) drain(userId, 'outbox already active');
  return onOutboxRegistered((registered) => drain(registered, 'outbox registered'));
}

/**
 * The instant a queued outbox entry announces when it is a `read_watermark`, else null - which is
 * every other entry, a reaction or an edit included, so the latest-wins supersede never touches one.
 * Read from the entry's own pre-encoded proto: the queue row has no column saying what it carries.
 */
export function queuedReadWatermarkAt(entry: OutboxEntry): number | null {
  if (entry.kind !== 'control' || !entry.controlProto) return null;
  const system = decodeAppMessage(entry.controlProto)?.system;
  if (system?.event !== 'read_watermark') return null;
  try {
    // ONLY A SERVER-CLOCK MARK TAKES PART in latest-wins: a stamped `{at}` (queued before 2026-10-31,
    // or flushed from the stamped ledger) is on another clock, and comparing the two numbers would
    // let one supersede the other on a meaningless order. Each stamped frame is simply sent.
    const mark = readWatermarkFrameMark(JSON.parse(system.data ?? '') as object);
    return mark?.clock === 'server' ? mark.at : null;
  } catch (e) {
    console.warn(
      `[OUTBOX] queued read_watermark ${entry.id.slice(0, 8)}… has unreadable data, left alone:`,
      e
    );
    return null;
  }
}
