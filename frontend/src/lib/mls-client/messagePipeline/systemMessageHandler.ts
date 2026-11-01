import type { Conversation } from '$lib/types';
import type { IncomingDeliveryMeta } from '$lib/mls-client/incomingDelivery';
import { canonicalIdentity, canonicalUserId, canonicalUserOf } from '$lib/mls-client/leafIdentity';
import {
  serializeEnvelope,
  applyEditToBody,
  mkChannelInviteEnvelope,
  mkChannelInviteSentEnvelope,
  channelInviteMessageId,
} from '$lib/envelope';
import { resolveDisplayNames } from '$lib/utils/users/displayName';
import { receivedNoticeTime, renderVisibleNotice } from '$lib/utils/chat/visibleNotices';
import { applyReaction } from '$lib/utils/chat/messageReactions';
import { editSupersedes } from '$lib/utils/chat/editPrecedence';
import { clearMessageControlRefusals } from '$lib/utils/chat/controlRefusals.svelte';
import { purgeConversation, retireConversation } from '$lib/utils/chat/conversations';
import { dropGroupState } from '$lib/utils/chat/dropGroupState';
import { recordEviction } from '$lib/utils/chat/eviction';
import {
  digestIdentity,
  noteProbeReceived,
  takeDigestSolicitation,
} from '$lib/utils/chat/historyDigestRendezvous';
import { answerHistoryDigest, pullFromOverheardDigest } from '$lib/utils/chat/historyDiffAnswer';
import { parseHistoryDigest, selectEntryIdsForPrefixes } from '$lib/utils/chat/historyManifest';
import { mergeHistoryFloor, parseHistorySince } from '$lib/utils/chat/historyWindow';
import { parseHistoryStateKey } from '$lib/utils/chat/historyStateKey';
import { answerAfterMailboxDrained, noteCoverageShortfall } from '$lib/utils/chat/historyReconcile';
import { owedPullTicket } from '$lib/utils/chat/historyOverheardPull';
import { dropOwnExcludedMessages } from '$lib/utils/chat/historyEntitlement';
import {
  mergeVettedRow,
  upgradedRow,
  upgradePatch,
  vetBundle,
} from '$lib/utils/chat/bundleVetting';
import type { RecordedAuthorship } from '$lib/crypto/messageAuthorship';
import { noteIntegrityFinding } from '$lib/mls-client/integrityFindings';
import {
  boundAddressedMessages,
  parseHistoryRequestId,
  takeAddressedAsk,
} from '$lib/utils/chat/historyAddressing';
import {
  historyGroupStartFor,
  historyRangeStartFor,
  readHistoryEntries,
  sendHistoryBundleForIds,
  sendHistoryDigest,
} from '$lib/utils/chat/groupActions';
import {
  countUnreadForUser,
  mergeReadWatermarks,
  parseReadWatermarks,
  readPointFor,
  boundedServerMarks,
  receivedReadWatermarkMark,
  watermarkAfterReading,
  withOwnReadAdvanced,
  withReadMark,
} from '$lib/utils/chat/readState';
import { boundedByVerifiedSentAt, withVettedBundleServerTimes } from '$lib/utils/chat/messageTime';
import { applyPin, mergePinEntries } from '$lib/stores/pinStore.svelte';
import { m } from '$lib/paraglide/messages';
import type { MessageHandlerDeps } from './deps';

/**
 * Context passed to handleSystemEvent - extends MessageHandlerDeps with
 * per-message fields that are only known inside the message-processing callback.
 */
export interface SystemEventContext extends MessageHandlerDeps {
  /** Snapshot of the conversation at the moment the system message was received. */
  convo: Conversation;
  /** Conversation key in the conversations map (= MLS group id). */
  convoKey: string;
  /** Normalised (lowercase) sender user id. */
  senderNorm: string;
  /**
   * The frame's OWN id, as the sender minted it (`mkVisibleSystem`), or undefined for a frame from
   * a build that sent none.
   *
   * It is what makes a notice written here the SAME ROW as the one the archive replay writes for
   * the same event, and as the one a peer's `history_bundle` carries - all three compare ids, and
   * before this existed all three minted their own, so one membership change drew one bubble per
   * replay and per bundle. Undefined keeps the old behaviour for an old frame, which is a
   * duplicate-prone row this build cannot repair: see `docs/wiki/legacy-compatibility.md`.
   */
  messageId?: string;
  /**
   * The frame's own `sentAt` (Unix ms) as the sender minted it (`mkVisibleSystem`), or undefined for
   * a frame that carries none. With `deliveryMeta.queuedCreatedAt` it dates the notice this event
   * draws ({@link receivedNoticeTime}) - when the event happened, never when this device learnt of it.
   */
  sentAt?: number;
  /**
   * The event frame's own author proof, as mls-core verified it (`recordAuthorship`). Kept on the
   * row an `edit_message` or `delete_message` changes, so a history bundle can prove the change to a
   * device that never saw this frame. Absent for an unsigned frame (an older sender).
   */
  authorship?: RecordedAuthorship;
  /** Persist MLS state to storage immediately (used when group membership changes). */
  /** Queue metadata for messages received via the offline delivery queue. */
  deliveryMeta?: IncomingDeliveryMeta;
}

/**
 * May `senderNorm` rewrite or remove `target`? Only its own author may.
 *
 * WHY THIS IS ENFORCED ON RECEIPT, not only where the action is offered. `isOwnMessage` gates the
 * edit and delete controls, but it runs on the device that SENDS the event - it decides what to put
 * on the wire, and a check that lives on the attacker's side of the wire is not a check. Every other
 * member then applied `delete_message` / `edit_message` by message id alone, so a member of a group
 * could silently remove or rewrite ANY other member's message on EVERY device in it. Nothing else
 * would have caught it: DMs and groups carry no server authority over their content the way channels
 * do, precisely because the server cannot read them.
 *
 * The identity is the one MLS itself authenticated for the frame, which is what makes this
 * sufficient rather than advisory: a member can lie about the message id, never about who they are.
 *
 * Refusing is silent to the user by design - the honest reading is that a peer sent something it had
 * no right to send, which is not the local user's problem to act on - but it is never silent in the
 * log, because a swallowed branch in a best-effort path leaves nothing else behind.
 */
function mutationIsAuthorised(
  target: { senderId?: string },
  senderNorm: string,
  kind: 'edit' | 'delete',
  log: (msg: string) => void
): boolean {
  // The ONE canonical user id (leafIdentity.ts), as the replay and MLS compare it.
  const owner = canonicalUserId(target.senderId ?? '');
  if (owner && owner === canonicalUserId(senderNorm)) return true;
  log(
    `[MLS] Refused ${kind === 'edit' ? 'an edit' : 'a delete'} of a message owned by ${owner.slice(0, 8) || 'unknown'} from ${senderNorm.slice(0, 8)} - only the author may mutate it`
  );
  return false;
}

/**
 * The most this device will answer to one scrollback ask, whatever the asker requests.
 *
 * The bound belongs on the ANSWERING side as well as the asking one: `limit` arrives from a peer,
 * and a peer that names a million turns a reader's scroll into an unbounded store dump. Sized to a
 * few screens, which is what a scroll gesture is worth - reaching further is more scrolling.
 */
const HISTORY_RANGE_MAX = 200;

/**
 * Validates the `from` of a probe and returns it, or `null` after logging why it was refused.
 *
 * `senderNorm` is the user the delivery server's ENVELOPE names - NOT, as this comment claimed until
 * 2026-09-28, the one MLS authenticated: the verified credential was dropped where the plaintext was
 * returned. The two are compared since WP-G2-1 (`verifiedSender`, measured, not refused), and this
 * check becomes one against the verified sender with the refusal half (channel-encryption section
 * 21). The device half of `from` is self-asserted either way. Cross-checking the user means the only
 * thing a member can misreport is which of its OWN devices it is - which costs a mis-addressed bundle
 * its owner can already read, never another member's history.
 *
 * One function because every leg of the exchange establishes identity the same way, and a check
 * copied five times is a check that will exist in four places after the next edit.
 */
function probeSender(
  data: any,
  senderNorm: string,
  log: (msg: string) => void,
  tag: string
): string | null {
  const from = String(data?.from ?? '');
  // Parsed by the ONE identity reader (`leafIdentity.ts`): `from` must name a DEVICE, so a bare user
  // id or a second colon names nobody, and the user half compares as Rust compares it.
  const device = canonicalIdentity(from);
  const claimedUser = device === null ? null : canonicalUserOf(device);
  if (claimedUser === null || claimedUser !== canonicalUserId(senderNorm)) {
    log(`[${tag}] Rejected: "${from}" does not match the MLS sender ${senderNorm}`);
    return null;
  }
  return from;
}

/**
 * Dispatches a decoded MLS system event to the appropriate handler.
 *
 * Called from setupMessageHandler after JSON-parsing `msg.system.data`.
 * Always returns `true` (ACK) - unknown events are silently ignored so
 * they don't block the delivery queue.
 */

export async function handleSystemEvent(
  event: string,
  data: any,
  ctx: SystemEventContext
): Promise<boolean> {
  const {
    mlsService,
    storage,
    userId,
    deviceKey,
    conversations,
    messageReactions,
    addMessageToChat,
    batchAddMessages,
    deleteConversation,
    saveConversation,
    getSelectedContact,
    setSelectedContact,
    onReadStateAdvanced,
    log,
    convo,
    convoKey,
    senderNorm,
    messageId,
    sentAt,
    deliveryMeta,
    authorship,
  } = ctx;

  /**
   * Writes the notice this event draws, DATED BY THE FRAME ({@link receivedNoticeTime}): its `sentAt`
   * and the server's acceptance, exactly as a received text row is. Every notice branch below writes
   * through here, so none of them can fall back to this device's clock again - which is what put
   * "X added A, B" below the whole conversation on a device that drained the frame late.
   *
   * With neither time the row is NOT drawn, and that is refused at ERROR: no delivery route of this
   * build omits the server time, so reaching it means a route lost it, and the fix belongs there.
   */
  const writeNotice = async (content: string, id: string | undefined): Promise<void> => {
    const dated = receivedNoticeTime(sentAt, deliveryMeta?.queuedCreatedAt);
    if (!dated) {
      console.error(
        `[NOTICE] REFUSED to draw '${event}' from ${senderNorm.slice(0, 8)} in ${convoKey.slice(0, 8)}… (id ${id?.slice(0, 8) ?? 'none'}): the frame carries no sentAt and its delivery no server time - no durable instant dates it, and this device's clock is not one`
      );
      return;
    }
    await addMessageToChat('system', content, convoKey, {
      isSystem: true,
      messageId: id,
      ...dated,
    });
  };

  // `decrypt_failed` was the narrow repair: a peer that could not decrypt asked every member to
  // re-send whatever it had sent in the last two minutes. It is gone, and this branch stays only to
  // absorb it from a peer running an older build - answering would restart exactly the broadcast the
  // deletion removes, and the requester's own history diff repairs it correctly and by name.
  if (event === 'decrypt_failed') {
    log(
      `[MLS] Ignoring a legacy decrypt_failed from ${senderNorm} in ${convoKey.slice(0, 8)}… - the history diff repairs this by name`
    );
    return true;
  }

  // A peer is telling us, in sixteen characters, everything it holds for this conversation, so the
  // elected member can answer "we agree" without either side opening its store. The first leg of
  // every reconciliation and usually the only one.
  //
  // Only RECORDED here: the election arrives by a different transport, and the two are joined by the
  // rendezvous so they can land in either order.
  if (event === 'history_state') {
    const from = probeSender(data, senderNorm, log, 'HISTORY_STATE');
    if (!from) return true;
    const key = parseHistoryStateKey(data?.key);
    if (!key) {
      log(`[HISTORY_STATE] Malformed key from ${senderNorm} for ${convoKey.slice(0, 8)}…`);
      return true;
    }
    const since = parseHistorySince(data?.since);
    if (since === null) {
      log(`[HISTORY_STATE] No window stated by ${senderNorm} for ${convoKey.slice(0, 8)}…`);
      return true;
    }
    noteProbeReceived(convoKey, from, { kind: 'state', key, since });
    log(
      `[HISTORY_STATE] From ${senderNorm} for ${convoKey.slice(0, 8)}… - ${key}, from ${since > 0 ? new Date(since).toISOString() : 'the beginning'}`
    );
    return true;
  }

  // The elected member compared our state key against its own, found them different, and is asking
  // us to describe ourselves properly. The SECOND leg of one solicitation, which is why the digest
  // it triggers lands on the same rendezvous rather than starting a new exchange.
  if (event === 'history_digest_request') {
    const me = digestIdentity(userId, mlsService.getDeviceId());
    if (String(data?.to ?? '').toLowerCase() !== me.toLowerCase()) return true;
    if (!probeSender(data, senderNorm, log, 'HISTORY_STATE')) return true;

    log(
      `[HISTORY_STATE] ${senderNorm} holds something different for ${convoKey.slice(0, 8)}… - describing our store`
    );
    // OUR MAILBOX FIRST: a digest computed while this device is still applying its own queue
    // describes a store it is in the middle of completing, so the asker diffs against a snapshot
    // that was already wrong when it was taken.
    answerAfterMailboxDrained(mlsService, convoKey, () =>
      sendHistoryDigest(convoKey, me, {
        storage,
        deviceKeyB64: deviceKey(),
        mlsService,
        log,
      }).catch((e) =>
        log(`[HISTORY_DIGEST] Could not answer ${senderNorm}: ${String(e).slice(0, 120)}`)
      )
    );
    return true;
  }

  // A peer is telling us what it holds for this conversation, so that whichever member the server
  // elects can answer a solicitation with the DIFFERENCE rather than its whole store (WP-HIST-3).
  if (event === 'history_digest') {
    const from = probeSender(data, senderNorm, log, 'HISTORY_DIGEST');
    if (!from) return true;
    const digest = parseHistoryDigest(data?.digest);
    if (!digest) {
      log(`[HISTORY_DIGEST] Malformed digest from ${senderNorm} for ${convoKey.slice(0, 8)}…`);
      return true;
    }
    // The window the asker drew, carried to whichever leg of the exchange ends up answering. Stating
    // none is malformed: every sender types it as required, so its absence is a broken frame rather
    // than an old peer, and answering it in full would be inventing a window on the asker's behalf.
    const since = parseHistorySince(data?.since);
    if (since === null) {
      log(`[HISTORY_DIGEST] No window stated by ${senderNorm} for ${convoKey.slice(0, 8)}…`);
      return true;
    }
    const requestId = parseHistoryRequestId(data?.requestId);
    const takenByAWaiter = noteProbeReceived(convoKey, from, {
      kind: 'digest',
      digest,
      since,
      requestId,
    });
    const size =
      digest.mode === 'ids'
        ? `${digest.ids.length} id(s)`
        : `${digest.ranges.length} slice(s) at depth ${digest.depth}`;
    log(
      `[HISTORY_DIGEST] From ${senderNorm} for ${convoKey.slice(0, 8)}… - ${digest.mode}, ${size}, asking from ${since > 0 ? new Date(since).toISOString() : 'the beginning'}`
    );

    // THE LATE HALF OF AN EXCHANGE WE OPENED, and answering it here is what stops a slow peer from
    // costing messages permanently. `handleHistoryRequest` waits `DIGEST_TTL_MS` for this frame and
    // then returns; the digest that arrives afterwards used to be recorded and never looked at
    // again, and nothing anywhere would ask a second time - measured 2026-09-05, a device that had
    // just rejoined took 67 s to drain twenty external joins against that 60 s wait and stayed three
    // messages short for ever.
    //
    // It needs no continuation because it needs no memory: the digest carries the manifest and the
    // window, our store carries the rest. `takeDigestSolicitation` is what keeps it addressed - this
    // leg is a group broadcast, so every member records it, and only the one that ASKED consumes an
    // outstanding solicitation and answers. The election still elects exactly one responder.
    if (!takenByAWaiter && takeDigestSolicitation(convoKey, from)) {
      // SILENT, because this IS the road now and it says nothing a reader can act on. The line above
      // reports the digest, and `[HISTORY_REQ] ... diff with <them>` reports what it produced; a
      // third line between them announced a road that no longer has an alternative, once per group
      // per enrolment.
      //
      // OUR MAILBOX FIRST, for the same reason every other store read in this file waits: a diff
      // resolved mid-drain names what we hold SO FAR and tells the asker that is all there is.
      answerAfterMailboxDrained(mlsService, convoKey, () =>
        answerHistoryDigest({
          groupId: convoKey,
          requesterIdentity: from,
          selfIdentity: digestIdentity(userId, mlsService.getDeviceId()),
          digest,
          since,
          requestId,
          deps: { storage, deviceKeyB64: deviceKey(), mlsService, log },
        }).catch((e) =>
          log(
            `[HISTORY_DIGEST] Late answer failed for ${convoKey.slice(0, 8)}…: ${String(e).slice(0, 120)}`
          )
        )
      );
    } else if (!takenByAWaiter) {
      // OVERHEARD: an exchange between two other members, and the author's full list of what it
      // holds. Not ours to ANSWER - the election picked one responder - but it is the only evidence
      // this device may ever get of a message it lacks, so we ask the author for that and nothing
      // else. It used to fall through here without a line (production, 2026-10-13: a browser saw
      // its owner's phone list seven ids, held six, and never said so). See `pullFromOverheardDigest`.
      // The ticket is taken NOW, while this is still the session and the conversation the digest
      // arrived in; the pull runs after the drain, and a sign-out or a leave can fall in between.
      const ticket = owedPullTicket(convoKey);
      answerAfterMailboxDrained(mlsService, convoKey, () =>
        pullFromOverheardDigest({
          groupId: convoKey,
          holderIdentity: from,
          selfIdentity: digestIdentity(userId, mlsService.getDeviceId()),
          digest,
          ticket,
          deps: { storage, deviceKeyB64: deviceKey(), mlsService, log },
        }).catch((e) =>
          log(
            `[HISTORY_DIGEST] Overheard-digest pull failed for ${convoKey.slice(0, 8)}…: ${String(e).slice(0, 120)}`
          )
        )
      );
    }
    return true;
  }

  // Scrollback: a reader reached the top of what their device holds and is asking for the page
  // before it. Same rendezvous, same election, different boundary - and bounded by `limit`, so the
  // answer is one page whatever the conversation's size.
  if (event === 'history_range') {
    const from = probeSender(data, senderNorm, log, 'HISTORY_RANGE');
    if (!from) return true;
    const before = Number(data?.before);
    const limit = Number(data?.limit);
    const since = parseHistorySince(data?.since);
    if (
      !Number.isFinite(before) ||
      before <= 0 ||
      !Number.isFinite(limit) ||
      limit <= 0 ||
      since === null
    ) {
      log(`[HISTORY_RANGE] Unusable range from ${senderNorm} for ${convoKey.slice(0, 8)}…`);
      return true;
    }
    noteProbeReceived(convoKey, from, {
      kind: 'range',
      before: Math.floor(before),
      limit: Math.min(Math.floor(limit), HISTORY_RANGE_MAX),
      since,
      requestId: parseHistoryRequestId(data?.requestId),
    });
    log(
      `[HISTORY_RANGE] ${senderNorm} wants up to ${limit} message(s) before ${new Date(before).toISOString()} in ${convoKey.slice(0, 8)}…`
    );
    return true;
  }

  // A peer has finished answering us and is stating where its OWN history begins - which it only
  // does when that is later than the instant we asked from. THE FOURTH TRIGGER: this is the one edge
  // raised by an answer rather than by something this device noticed about itself, and it is what
  // tells a clipped answer apart from a conversation that simply has no more past.
  if (event === 'history_coverage') {
    const me = digestIdentity(userId, mlsService.getDeviceId());
    if (String(data?.to ?? '').toLowerCase() !== me.toLowerCase()) return true;
    const from = probeSender(data, senderNorm, log, 'HISTORY_COVERAGE');
    if (!from) return true;
    const coveredFrom = Number(data?.coveredFrom);
    if (!Number.isFinite(coveredFrom) || coveredFrom <= 0) {
      log(`[HISTORY_COVERAGE] Unusable coverage from ${senderNorm} for ${convoKey.slice(0, 8)}…`);
      return true;
    }

    // OUR OWN WINDOW, not the `since` the peer echoed back. The question this answers is "does that
    // peer cover what THIS device wants", and only this device is entitled to say what that is - the
    // echo is what the peer compared against, which is one round trip old and, either side of
    // midnight, a different day.
    const since = await historyRangeStartFor(convoKey, storage);
    // AND WHERE THE GROUP BEGAN, a fact this device holds about its own row: a shortfall below it
    // is a past nobody can hold, and walking the membership for it was 8 elections on BIG-1.
    const startedAt = await historyGroupStartFor(convoKey, storage);
    void noteCoverageShortfall(
      mlsService,
      convoKey,
      from,
      { since, coveredFrom: Math.floor(coveredFrom), startedAt },
      log
    ).catch((e) =>
      log(
        `[HISTORY_COVERAGE] Chase failed for ${convoKey.slice(0, 8)}…: ${String(e).slice(0, 120)}`
      )
    );
    return true;
  }

  // The mirror image: a peer diffed our digest against its own store, found messages IT lacks, and
  // is asking us for them by name. Every leg of this exchange is a group broadcast, so the first
  // thing to establish is whether it was meant for us at all.
  //
  // This is where the exchange terminates, and that is deliberate: a pull is answered by a bundle,
  // and a bundle asks for nothing. Nothing here can re-enter the loop it came from.
  if (event === 'history_pull') {
    const me = digestIdentity(userId, mlsService.getDeviceId());
    if (String(data?.to ?? '').toLowerCase() !== me.toLowerCase()) return true;

    // Our answer is a group broadcast addressed back to the puller, so its identity is established
    // here exactly as every other leg does it. An unusable `from` is dropped rather than answered to
    // nobody - a bundle with no addressee is pure traffic.
    const puller = probeSender(data, senderNorm, log, 'HISTORY_PULL');
    if (!puller) return true;

    const deps = { storage, deviceKeyB64: deviceKey(), mlsService, log };
    const ids = Array.isArray(data?.ids)
      ? (data.ids as unknown[]).filter((id): id is string => typeof id === 'string' && !!id.trim())
      : [];
    // The depth the prefixes were computed at travels with them: a prefix names a slice of the id
    // space only relative to a depth, and re-deriving it from our OWN store's size would name a
    // different slice on each device.
    const depth = Number(data?.depth);
    const prefixes =
      Array.isArray(data?.prefixes) && Number.isInteger(depth) && depth >= 1
        ? (data.prefixes as unknown[]).filter(
            (p): p is string => typeof p === 'string' && p.length === depth && /^[0-9a-f]+$/.test(p)
          )
        : [];
    // The puller's own window, which is NOT the one we would have used: it may retain five years
    // where we keep ninety days, or the reverse. Only the asker may set the bound on its answer, so
    // a pull that states none is declined rather than answered over a window we invented for it.
    const since = parseHistorySince(data?.since);
    if (since === null) {
      log(`[HISTORY_PULL] No window stated by ${senderNorm} for ${convoKey.slice(0, 8)}…`);
      return true;
    }

    // EVERYTHING THAT READS THE STORE WAITS FOR OUR MAILBOX - the selection as much as the send. A
    // prefix slice resolved mid-drain names the messages we hold SO FAR, so the bundle is short of
    // exactly the frames we were about to apply, and the puller is told that is all there is.
    // Parsing above is pure and stays inline; only what depends on the store is deferred.
    answerAfterMailboxDrained(mlsService, convoKey, async () => {
      let wanted = ids;
      if (wanted.length === 0 && prefixes.length > 0) {
        // A range diff resolves to a slice of the id space, never to a message, so the asker cannot
        // name what it wants: it names the slice and we send everything we hold in it. The receiver
        // dedupes by id, so over-sending costs bandwidth and nothing else.
        const entries = await readHistoryEntries(convoKey, deps);
        if (entries === null) {
          log(
            `[HISTORY_PULL] Store unreadable - cannot answer ${senderNorm} for ${convoKey.slice(0, 8)}…`
          );
          return;
        }
        wanted = selectEntryIdsForPrefixes(entries, prefixes, depth);
      }
      if (wanted.length === 0) {
        log(
          `[HISTORY_PULL] ${senderNorm} asked for nothing usable in ${convoKey.slice(0, 8)}… - ignored`
        );
        return;
      }

      log(
        `[HISTORY_PULL] ${senderNorm} wants ${wanted.length} message(s) from ${convoKey.slice(0, 8)}…`
      );
      await sendHistoryBundleForIds(convoKey, wanted, deps, {
        to: puller,
        since,
        requestId: parseHistoryRequestId(data?.requestId),
      }).catch((e) => log(`[HISTORY_PULL] Answer failed: ${String(e).slice(0, 120)}`));
    });
    return true;
  }

  if (event === 'channel_invitation') {
    const channelId = String(data.channelId || '');
    const channelName = String(data.channelName || channelId);
    const workspaceName = data.workspaceName ? String(data.workspaceName) : undefined;
    const workspaceImageMediaId = data.workspaceImageMediaId
      ? String(data.workspaceImageMediaId)
      : undefined;

    if (!channelId) {
      // An invitation naming no salon cannot be rendered and cannot be deduplicated either - the
      // stable id is derived from it. Refusing is right; refusing in silence is what made an
      // invitation that reached a device and produced nothing unattributable from any log.
      log(
        `[CHANNEL_INVITE] refusing an invitation from ${senderNorm.slice(0, 8)} in ${convoKey.slice(0, 8)}… - it names no channel`
      );
      return true;
    }

    const inviteeId = String(data.inviteeId || '');
    const inviteMessageId = channelInviteMessageId(channelId, inviteeId);

    if (senderNorm === userId) {
      // The inviter's OTHER devices: MLS never returns a message to the device that sent it, so
      // this branch is only ever reached on a second device. The sending device inserts the same
      // card locally in `inviteMemberToChannel`.
      const inviteeDisplayName = String(data.inviteeName || data.inviteeId || '');
      await writeNotice(
        serializeEnvelope(
          mkChannelInviteSentEnvelope(
            channelId,
            workspaceName ?? channelName,
            workspaceName,
            inviteeDisplayName,
            workspaceImageMediaId
          )
        ),
        inviteMessageId
      );
      log(
        `[CHANNEL_INVITE] our own invitation of ${inviteeId.slice(0, 8)} to ${channelId.slice(0, 8)}, seen from another device - card ${inviteMessageId} into ${convoKey.slice(0, 8)}…`
      );
    } else {
      // The invitee receives the invitation card
      const inviterDisplayName = String(data.inviterName || '');
      const inviteEnvelope = serializeEnvelope(
        mkChannelInviteEnvelope(
          channelId,
          workspaceName ?? channelName,
          workspaceName,
          inviterDisplayName,
          workspaceImageMediaId
        )
      );
      await writeNotice(inviteEnvelope, inviteMessageId);
      // THE ONLY THING THE INVITEE IS EVER TOLD. A direct invitation makes them a member with no
      // gesture of their own, so this card is the whole notification - and one line saying it was
      // written, naming the conversation it went into, is what separates "never delivered" from
      // "delivered into a conversation nobody is looking at".
      log(
        `[CHANNEL_INVITE] invited to ${channelId.slice(0, 8)} by ${senderNorm.slice(0, 8)} - card ${inviteMessageId} into ${convoKey.slice(0, 8)}…`
      );
    }

    return true;
  }

  if (event === 'groupRenamed' && data.newName) {
    conversations.set(convoKey, { ...convo, name: data.newName });
    if (storage) await saveConversation(convoKey);
    const text = await renderVisibleNotice('groupRenamed', data, senderNorm);
    if (text) await writeNotice(text, messageId);
    log(`📝 Group renamed by ${senderNorm}`);
    return true;
  }

  if (event === 'groupImageChanged') {
    const imageMediaId =
      typeof data.imageMediaId === 'string' && data.imageMediaId ? data.imageMediaId : null;
    conversations.set(convoKey, { ...convo, imageMediaId });
    if (storage) await saveConversation(convoKey);
    const text = await renderVisibleNotice('groupImageChanged', data, senderNorm);
    if (text) await writeNotice(text, messageId);
    log(`🖼️ Group photo changed by ${senderNorm} (media=${imageMediaId ?? 'null'})`);
    return true;
  }

  if (event === 'memberRemoved' && data.targetUser) {
    if (data.targetUser.toLowerCase() === userId.toLowerCase()) {
      // Current user was excluded. Mirror the peer-delete (`groupDeleted`) handling instead of a
      // silent purge: forget the WASM state (we can no longer decrypt future epochs) but KEEP the
      // local conversation as `removed`. The user reads the history behind a banner and deletes it
      // manually - which dismisses it on ALL their devices. A silent purge here dropped the
      // conversation everywhere with no visible trace.
      // Deferred, which is what `persistMlsStateNow` did here: the pipeline's persister coalesces,
      // and the conversation row saying `removed` is written durably by `recordEviction` below.
      await dropGroupState(mlsService, convo.id, {
        reason: 'we were removed from the group',
        checkpoint: 'deferred',
        log,
      });
      // THE ANNOUNCEMENT IS ONE OF SIX EVIDENCES, NOT A SEPARATE ENDING. The retire and the notice
      // used to be written out here, and they were the only pair of the five learning sites that
      // did both - which is why the other four each lacked one half.
      await recordEviction({
        conversations,
        groupId: convo.id,
        evidence: 'system-event',
        // The server's acceptance of the announcement its author sent right after the Remove commit.
        removedAt: deliveryMeta?.queuedCreatedAt,
        askRemovedAt: () => mlsService.ownRemovalAt(convo.id),
        ownerId: userId,
        saveConversation,
        addMessageToChat,
        log,
      });
      log(`[INFO] Excluded from group "${convoKey}" by ${senderNorm} - marked removed`);
    } else {
      const text = await renderVisibleNotice('memberRemoved', data, senderNorm);
      if (text) await writeNotice(text, messageId);
    }
    return true;
  }

  if (event === 'memberLeft' && data.userId) {
    // THE DEPARTURE NOTICE HAD A WRITER ON THE REPLAY AND NONE HERE. `leaveGroupAndBroadcast` has
    // always broadcast this frame and `applyReplaySystemEvent` has always rendered it, so a member
    // walking out showed NOTHING to anybody until that member's next archive replay - and then at
    // its original place in the scrollback rather than at the moment it happened. This branch is
    // the missing half, and it renders the same Paraglide message against the same frame id so the
    // bubble it writes and the one the replay writes are the SAME ROW rather than two.
    const leaver = String(data.userId);

    // Only the party that left may say so. The id is a self-asserted payload field where the
    // sender is the identity MLS itself authenticated, so this is the one cross-check available -
    // and without it any member could announce any other member's departure to the whole group.
    // The send site never disagrees: `notifyMembershipChange` is handed the caller's own id.
    if (canonicalUserId(leaver) !== canonicalUserId(senderNorm)) {
      log(
        `[MLS] Refused a memberLeft from ${senderNorm.slice(0, 8)} announcing ${leaver.slice(0, 8)} - only the leaver may announce its own departure`
      );
      return true;
    }

    // OUR OWN DEPARTURE, REACHING ANOTHER OF OUR DEVICES. MLS never returns a frame to the client
    // that sent it, so this is only ever a sibling device, and it must not draw "you left the
    // group" into a conversation it is about to lose: leaving de-registers the USER, so the server
    // refuses that group's membership check on every device, and `verifyMembership` retires the row
    // from there. Logged rather than silent, because that retire happens on a different loop.
    if (canonicalUserId(leaver) === canonicalUserId(userId)) {
      log(
        `[INFO] We left "${convoKey}" from another device - no notice here, the membership check retires it`
      );
      return true;
    }

    const getName = await resolveDisplayNames([leaver]);
    await writeNotice(m.chat_system_member_left({ user: getName(leaver) }), messageId);
    log(`[INFO] ${leaver} left group "${convoKey}"`);
    return true;
  }

  if (event === 'memberAdded') {
    // The ONE rendering (`visibleNotices.ts`): the adder's device writes the same row under the
    // same id itself, since MLS never hands it this frame.
    const text = await renderVisibleNotice('memberAdded', data, senderNorm);
    if (text) await writeNotice(text, messageId);
    return true;
  }

  if (event === 'groupDeleted') {
    const getName = await resolveDisplayNames([senderNorm]);
    const senderName = getName(senderNorm);
    await dropGroupState(mlsService, convo.id, {
      reason: 'the group was deleted by a member',
      checkpoint: 'deferred',
      log,
    });

    if (senderNorm === userId) {
      // Deletion performed by us on another device: remove immediately
      // without user interaction (syncing our own action).
      if (getSelectedContact() === convoKey) setSelectedContact(null);
      // A purge removes the row, so nothing keyed by the group is reachable through the UI any
      // more - but the awaiting-history marker is keyed by the GROUP, not by the row, and outlives
      // it. That is where this rig's orphan markers came from: conversations deleted on another
      // device, whose markers then sat in localStorage until the 30-day horizon.
      await purgeConversation({
        conversations,
        key: convoKey,
        groupId: convo.id,
        deleteStored: deleteConversation,
      });
      log(`[INFO] Group deleted on another device - conversation removed immediately`);
    } else {
      // Deleted by another participant: add a visible message and set the
      // conversation to `removed` so the user can read the history before closing.
      await writeNotice(m.chat_system_conversation_deleted({ sender: senderName }), messageId);
      await retireConversation({
        conversations,
        key: convoKey,
        groupId: convo.id,
        saveConversation,
      });
      log(`[INFO] Group deleted by ${senderNorm} - conversation marked removed`);
    }
    return true;
  }

  if (event === 'read_watermark' || event === 'read_receipt') {
    const c = conversations.get(convoKey);
    if (c) {
      // `read_receipt` is the shape senders used before the watermark, and it names message ids
      // instead of an instant. Translated rather than dropped: the ids we hold give the instant
      // directly, and ids we do not hold say nothing we could act on anyway.
      // A `read_watermark` says which clock it is on (`serverAt` from this build, a bare `at` from an
      // older one); ids translate through the rows we hold, whose key is the server's clock.
      const received =
        event === 'read_watermark'
          ? receivedReadWatermarkMark(data, deliveryMeta?.queuedCreatedAt)
          : null;
      if (received?.refused) {
        console.error(
          `[READ] REFUSED a read mark from ${senderNorm.slice(0, 8)} in ${convoKey.slice(0, 8)}…: ${received.refused}`
        );
      }
      const mark =
        event === 'read_watermark'
          ? (received?.mark ?? null)
          : {
              at: watermarkAfterReading(
                c.messages.filter((m) => (data.messageIds ?? []).includes(m.id)),
                0
              ),
              clock: 'server' as const,
            };
      const at = mark?.at ?? 0;
      const merged = mark ? withReadMark(c, senderNorm, mark.at, mark.clock) : null;
      // Read by OURSELVES on another device: clear the badge here too, which is the whole point of
      // the watermark travelling between our own devices. The count follows the watermark rather
      // than being zeroed, so a message newer than what was read there stays counted.
      const selfRead = senderNorm === userId;
      const next =
        selfRead && mark ? withOwnReadAdvanced(c, senderNorm, mark.at, mark.clock) : (merged ?? c);
      if (next !== c) {
        conversations.set(convoKey, next);
        // The read state lives on the conversation row, so this save is what persists it - for a
        // peer's watermark as much as for our own.
        await saveConversation?.(convoKey).catch(() => {});
      }
      if (merged) {
        log(
          `[READ] ${senderNorm} has read up to ${new Date(at).toISOString()} (${mark?.clock} clock)`
        );
        onReadStateAdvanced?.({ conversationKey: convoKey, senderId: senderNorm, at });
      }
    }
    return true;
  }

  if (event === 'delete_message') {
    const c = conversations.get(convoKey);
    if (c && data.messageId) {
      const idx = c.messages.findIndex((m) => m.id === data.messageId);
      if (idx !== -1 && !mutationIsAuthorised(c.messages[idx], senderNorm, 'delete', log))
        return true;
      if (idx !== -1) {
        const orig = c.messages[idx];
        const deletedMsg = {
          ...orig,
          isDeleted: true,
          content: m.chat_system_message_deleted(),
        };
        conversations.set(convoKey, {
          ...c,
          messages: c.messages.map((m, i) => (i === idx ? deletedMsg : m)),
        });
        // Deleted by another of the author's devices: a refused act on it has nothing left to retry.
        clearMessageControlRefusals(deletedMsg.id);
        if (storage) {
          try {
            // The tombstone and the replacement body, nothing else: the edit flags and the read
            // state of the message being deleted are not this handler's to rewrite. The original
            // signed bytes go with the body (`authorship`/`editProof: null`), and the author's
            // signed deletion stays, so a bundle can prove the tombstone to a device that missed it.
            await storage.updateMessage(
              deletedMsg.id,
              {
                isDeleted: true,
                content: deletedMsg.content,
                authorship: null,
                editProof: null,
                ...(authorship ? { deleteProof: authorship } : {}),
              },
              deviceKey()
            );
          } catch (e) {
            // Non-blocking: the tombstone holds in memory, a reload shows the message again.
            log(`[DELETE] tombstone of ${deletedMsg.id.slice(0, 8)} not persisted: ${String(e)}`);
          }
        }
      }
    }
    return true;
  }

  if (event === 'edit_message' && data.messageId && data.newContent) {
    const c = conversations.get(convoKey);
    if (c) {
      const idx = c.messages.findIndex((m) => m.id === data.messageId);
      if (idx !== -1 && !mutationIsAuthorised(c.messages[idx], senderNorm, 'edit', log))
        return true;
      if (idx !== -1) {
        const orig = c.messages[idx];
        // A DELETE IS ABSORBING: THE TOMBSTONE WINS, WHATEVER THE ORDER. The tombstone lives in
        // `content`, so an edit applied on top of it does not merely reorder two bodies - it puts
        // the deleted text back on screen, italic and faded, which is the one outcome a delete
        // exists to prevent. Reachable the same way the ordering defect was: two devices of one
        // account, one deleting while the other edits. The archive's own post-save pass
        // (`history.ts`, `if (deletion) ... else if (edit)`) has always had this rule; the live path
        // and the replay never did.
        if (orig.isDeleted) {
          log(
            `[MLS] Dropped an edit of ${String(data.messageId).slice(0, 8)} - the message is deleted and a tombstone is final`
          );
          return true;
        }
        const editedAtMs = typeof data.editedAt === 'number' ? data.editedAt : Date.now();
        // AN EDIT OLDER THAN THE ONE THIS ROW ALREADY CARRIES IS DROPPED, and dropping it is what
        // makes two devices agree. Applying on arrival meant the answer was "whichever frame came
        // last", which differs per device: MUT-18 crossed two edits from two devices of one account
        // and left W1 on A1's text and A1 on W1's, permanently, with no error anywhere. See
        // `editSupersedes` for why a sender-stamped clock is enough - convergence needs the same
        // winner, not the right one.
        if (!editSupersedes({ editedAt: editedAtMs, content: data.newContent }, orig)) {
          log(
            `[MLS] Dropped an edit of ${String(data.messageId).slice(0, 8)} dated ${editedAtMs} - the row already holds a later one`
          );
          return true;
        }
        const editedAt = new Date(editedAtMs);
        // No read state is reset here. It used to clear `readBy`, so an edited message showed as
        // read by nobody - which the watermark cannot express and should not: a watermark is
        // monotone, and a peer that never sees the edit would never agree to move back anyway.
        // THE EDIT CARRIES A TEXT, NOT A BODY. The reply reference lives inside the envelope in
        // `content` and nowhere else, so writing the bare text here deleted the quote from the row
        // - invisibly on the editing device, whose in-memory `replyTo` outlived the write, and
        // immediately on every device that re-read the row from disk. See `applyEditToBody`.
        const editedContent = applyEditToBody(orig.content, data.newContent);
        const editedMsg = { ...orig, isEdited: true, editedAt, content: editedContent };
        conversations.set(convoKey, {
          ...c,
          messages: c.messages.map((m, i) => (i === idx ? editedMsg : m)),
        });
        if (storage) {
          try {
            // The author's signed edit replaces any earlier one: it is what proves THIS body.
            await storage.updateMessage(
              editedMsg.id,
              {
                content: editedContent,
                isEdited: true,
                editedAt: editedAt.getTime(),
                editProof: authorship ?? null,
              },
              deviceKey()
            );
          } catch {
            // Non-blocking
          }
        }
      }
    }
    return true;
  }

  if (event === 'history_bundle') {
    // A BROADCAST BUNDLE IS FOR EVERYONE: an answer from an older peer, or from a server that
    // predates addressed answers, reaches every member and its messages are free to take - the merge
    // below dedupes by id, and nothing about the addressee is discharged by reading it.
    //
    // AN ADDRESSED ONE IS BELIEVED ONLY AS THE ANSWER TO OUR OWN ASK (step A, rule 5 of
    // docs/wiki/protocols/history-answer-addressing.md). The server routed it to this device alone,
    // so nobody else in the group can see what it carries; accepting it unsolicited would let one
    // member show this device a history the rest of the group never saw. So it must name an ask this
    // device made (or its admission, for the inviter's push), it may carry only messages inside what
    // that ask asked for, and it may only ADD them - the conversation state it restates is merged on
    // the push alone, which is the one answer whose reader has no state of its own yet.
    const addressee = String(data?.to ?? '');
    const me = digestIdentity(userId, mlsService.getDeviceId()).toLowerCase();
    type BundleMsg = {
      id: string;
      senderId: string;
      content: string;
      timestamp: number;
      reactions?: import('$lib/types').MessageReaction[];
      isDeleted?: boolean;
      isEdited?: boolean;
      editedAt?: number;
      serverTimestamp?: number;
      authorship?: RecordedAuthorship;
      editProof?: RecordedAuthorship;
      deleteProof?: RecordedAuthorship;
      authorUnproven?: boolean;
    };
    let incoming: BundleMsg[] = Array.isArray(data?.messages) ? data.messages : [];
    let addOnly = false;
    if (deliveryMeta?.addressed === true) {
      const requestId = parseHistoryRequestId(data?.requestId);
      const claimsJoin = data?.join === true && requestId === undefined;
      // THE ANSWERER IS THE DEVICE MLS VERIFIED: the decrypt compared the envelope's device with the
      // credential, which it can only do when the envelope names one - so an answer naming none has
      // no device to close the ask for, and is refused.
      const answeringDevice = deliveryMeta.senderDeviceId;
      const ask =
        addressee.toLowerCase() === me && answeringDevice && (requestId !== undefined || claimsJoin)
          ? takeAddressedAsk(
              convoKey,
              requestId,
              `${senderNorm}:${answeringDevice}`,
              data?.last === true
            )
          : null;
      if (ask === null || (ask.kind === 'join') !== claimsJoin) {
        // At error: an honest peer answers only an ask that carried an id, and closes it once, so
        // this is a forged frame, a defect, or an ask this page no longer holds (a reload between
        // ask and answer, or more than MAX_OPEN_ASKS_PER_GROUP open at once) - each worth a
        // reader's attention, and the comparison runs again on the next connection either way. A
        // SECOND responder to the same ask is not here (the rendezvous can re-elect once); a THIRD
        // is, because nothing honest produces one (MAX_ANSWERERS_PER_ASK).
        console.error(
          `[HISTORY_ADDRESSED] REFUSED an addressed history_bundle in ${convoKey.slice(0, 8)}… from ${senderNorm.slice(0, 8)} - ${addressee.toLowerCase() !== me ? `addressed to ${addressee.slice(0, 8) || 'nobody'}…, not us` : !answeringDevice ? 'its envelope names no sending device' : requestId === undefined && !claimsJoin ? 'it names no ask' : 'it answers no ask this device has open, or its answerers are all taken'} (${incoming.length} message(s) not ingested)`
        );
        return true;
      }
      const bounded = boundAddressedMessages(ask, incoming);
      if (bounded.outOfBound > 0) {
        console.error(
          `[HISTORY_ADDRESSED] ${bounded.outOfBound} message(s) of an addressed ${ask.kind} answer from ${senderNorm.slice(0, 8)} in ${convoKey.slice(0, 8)}… lie outside what we asked - dropped`
        );
      }
      incoming = bounded.kept;
      addOnly = ask.kind !== 'join';
    } else if (addressee && addressee.toLowerCase() !== me) {
      log(
        `[HISTORY_BUNDLE] ${convoKey.slice(0, 8)}… - broadcast answer for ${addressee.slice(0, 8)}…, ingesting it anyway`
      );
    }
    try {
      // A RELAYED SERVER TIME IS BELIEVED ONLY INSIDE WHAT THE SERVER ITSELF SAYS (`messageTime.ts`):
      // it is the order key and the read-mark key, and this member wrote it, not the server.
      const vettedTimes = withVettedBundleServerTimes(incoming, deliveryMeta?.queuedCreatedAt);
      if (vettedTimes.dropped > 0) {
        console.error(
          `[HISTORY_BUNDLE] ${vettedTimes.dropped} server time(s) relayed by ${senderNorm.slice(0, 8)} in ${convoKey.slice(0, 8)}… lie outside the bundle's own server time (${deliveryMeta?.queuedCreatedAt ?? 'unknown'}) - dropped, those rows keep their sentAt`
        );
      }
      const msgs: BundleMsg[] = vettedTimes.rows;
      // EVERY REFUSAL BELOW IS ONE OF THESE: a proof that does not hold is a member forging
      // history, which is logged at ERROR and reported - never merely skipped.
      const refuseForged = (what: string, id: string, why: string): void => {
        log(
          `[AUTHORSHIP] REFUSED a restored ${what} ${id.slice(0, 8)} relayed by ${senderNorm.slice(0, 8)} in ${convoKey.slice(0, 8)}…: ${why}`
        );
        noteIntegrityFinding({
          kind: 'forged-history',
          groupId: convoKey,
          peer: senderNorm,
          detail: what,
          proven: true,
        });
      };

      // 0) The conversation's own state - read watermarks and the shared history floor - which
      //    travels ONCE for the whole conversation rather than once per message. Merged before
      //    anything else so the unread recount in step 3 sees it, and merged even for an empty
      //    bundle: "you are missing no messages, and here is who has read what" is a perfectly
      //    ordinary answer. Both merges are `max`, so a value restated by every chunk is free.
      //    Not from an addressed answer to an ask (`addOnly`): it may only add messages.
      const beforeMerge = addOnly ? undefined : conversations.get(convoKey);
      if (beforeMerge) {
        const mergedWatermarks = mergeReadWatermarks(
          beforeMerge.readWatermarks,
          parseReadWatermarks(data.readWatermarks)
        );
        // The server-clock marks travel beside the stamped ones; an older sender has none.
        // Bounded like a read_watermark frame: none above the server's time for this bundle.
        const bundleServerMarks = boundedServerMarks(
          parseReadWatermarks(data.serverReadWatermarks),
          deliveryMeta?.queuedCreatedAt
        );
        if (bundleServerMarks.dropped > 0) {
          console.error(
            `[HISTORY_BUNDLE] ${bundleServerMarks.dropped} server-clock read mark(s) relayed by ${senderNorm.slice(0, 8)} in ${convoKey.slice(0, 8)}… lie after the bundle's own server time - dropped`
          );
        }
        const mergedServerWatermarks = mergeReadWatermarks(
          beforeMerge.serverReadWatermarks,
          bundleServerMarks.kept ?? undefined
        );
        const mergedFloor = mergeHistoryFloor(beforeMerge.historyFloor, data.floor);
        if (mergedWatermarks || mergedServerWatermarks || mergedFloor !== null) {
          conversations.set(convoKey, {
            ...beforeMerge,
            ...(mergedWatermarks ? { readWatermarks: mergedWatermarks } : {}),
            ...(mergedServerWatermarks ? { serverReadWatermarks: mergedServerWatermarks } : {}),
            ...(mergedFloor !== null ? { historyFloor: mergedFloor } : {}),
          });
          await saveConversation?.(convoKey).catch((e: unknown) => {
            log(
              `[HISTORY_BUNDLE] conversation state of ${convoKey.slice(0, 8)}… not persisted: ${String(e)}`
            );
          });
        }
      }

      // The pin register rides beside them, merged entry by entry on the same `at` the frames
      // carry. Reported only when something actually moved - a bundle restating what we already
      // hold is the common case and says nothing.
      const pinsMerged = addOnly ? 0 : mergePinEntries(convoKey, data.pins);
      if (pinsMerged > 0) {
        log(
          `[HISTORY_BUNDLE] ${pinsMerged} pin state(s) converged for ${convoKey.slice(0, 8)}… from ${senderNorm.slice(0, 8)}`
        );
      }

      if (msgs.length > 0) {
        const existingIds = new Set(convo.messages.map((m) => m.id));
        // HYGIENE, NOT A CONTROL (user, 2026-10-14: a Remove holds against a later re-add). The
        // answering peer withholds what was sent while a member was out; a message that still
        // reaches us from inside OUR OWN window is dropped here, each one logged. Only the messages
        // we would ADD are checked - one we already hold changes nothing - so a bundle restating
        // our own store costs no read. An unreadable window set ingests none of them.
        const fresh = await dropOwnExcludedMessages(
          convoKey,
          userId,
          msgs.filter((m) => !existingIds.has(m.id)),
          { mlsService, log }
        );
        // 1) WHAT THE BUNDLE MAY DO, decided by the ONE rule every bundle goes through, live or
        //    replayed from the archive (`bundleVetting.ts`): each message on its author's signature
        //    or its relayer's own word, a held MARKED row upgraded by a proof, and what each entry
        //    may change on its row - reactions, a tombstone, an edit. Decided before any write
        //    because a signature check is asynchronous and the merge below is not. An addressed
        //    answer to an ask (`addOnly`) changes only the rows it adds or upgrades.
        const heldRows = new Map(
          (conversations.get(convoKey)?.messages ?? []).map((row) => [row.id, row])
        );
        const vettedBundle = await vetBundle(
          mlsService,
          convoKey,
          {
            entries: msgs,
            fresh: fresh ?? [],
            held: heldRows,
            relayer: senderNorm,
            mutateHeld: !addOnly,
          },
          log,
          refuseForged
        );
        if (vettedBundle.unverified > 0) {
          log(
            `[AUTHORSHIP] ${vettedBundle.unverified} restored message(s) in ${convoKey.slice(0, 8)}… relayed by ${senderNorm.slice(0, 8)} carry no author proof - kept, marked unverified`
          );
        }

        // 2) The upgrades, in memory and at rest: the proven copy replaces the marked row ENTIRELY -
        //    sender, body and time - and the unproven edit state goes with it (a verified EDITED
        //    message carries its signed edit, which step 4 applies to this original).
        const upgrades = vettedBundle.upgrades;
        const beforeUpgrade = conversations.get(convoKey);
        if (upgrades.size > 0 && beforeUpgrade) {
          conversations.set(convoKey, {
            ...beforeUpgrade,
            messages: beforeUpgrade.messages.map((row) => {
              const up = upgrades.get(row.id);
              return up ? upgradedRow(row, up, userId) : row;
            }),
          });
          log(
            `[AUTHORSHIP] ${upgrades.size} held unverified message(s) in ${convoKey.slice(0, 8)}… proven by a copy relayed by ${senderNorm.slice(0, 8)} - upgraded`
          );
          for (const [id, up] of upgrades) {
            try {
              await storage?.updateMessage(id, upgradePatch(up), deviceKey());
            } catch (e) {
              log(`[AUTHORSHIP] upgrade of ${id.slice(0, 8)} not persisted: ${String(e)}`);
            }
          }
        }

        // 3) Add only the genuinely new messages. The add-path (AddMessageToChatOptions) cannot
        //    carry reactions/tombstones, so that metadata is merged in step 4 for new AND existing
        //    messages alike. A signed message is taken from the signed bytes - content and time -
        //    whatever the relayer wrote beside them.
        let belowSigned = 0;
        const toAdd = vettedBundle.fresh.map(({ entry: m, verdict }) => {
          // The relayed server time checked once more, against the SIGNED sentAt: the first check
          // could only read the relayer's own `timestamp` (`boundedByVerifiedSentAt`).
          const serverTimestamp =
            verdict.kind === 'verified'
              ? boundedByVerifiedSentAt(m.serverTimestamp, verdict.timestamp)
              : m.serverTimestamp;
          if (serverTimestamp === undefined && m.serverTimestamp !== undefined) belowSigned++;
          return {
            senderId: canonicalUserId(m.senderId),
            content: verdict.kind === 'verified' ? verdict.content : m.content,
            messageId: m.id,
            timestamp: new Date(verdict.kind === 'verified' ? verdict.timestamp : m.timestamp),
            // The order key: the relayed server time that survived both checks, or none.
            ...(typeof serverTimestamp === 'number' ? { serverTimestamp } : {}),
            // Kept whenever it was not refused - also when it could not be checked NOW - so this
            // device relays it on and a later reader can still prove it.
            ...(m.authorship ? { authorship: m.authorship } : {}),
            ...(verdict.kind === 'unverified' ? { restoredUnverified: true } : {}),
          };
        });
        if (belowSigned > 0) {
          console.error(
            `[HISTORY_BUNDLE] ${belowSigned} server time(s) relayed by ${senderNorm.slice(0, 8)} in ${convoKey.slice(0, 8)}… lie below the SIGNED sentAt - dropped, those rows keep their sentAt`
          );
        }
        if (toAdd.length > 0) {
          // NAMES ITS CONVERSATION AND ITS SENDER, like the pin line above it. This said
          // "from the inviting peer" and nothing else - wrong twice on a device rejoining forty
          // groups at once: the sender is whichever member the server's RANDOM election picked, not
          // an inviter, and a reader could not tell which of the forty conversations was repaired.
          // The repair is the one event this whole subsystem exists to produce, and it was the only
          // line in this block a reader could not attribute. It also made a campaign clause
          // unsatisfiable: HEAL-REVOKE-4 filters each client's trail by the group's id prefix, so
          // `theAskerAPPLIEDTheAnswer` could never be true, on any run, however well the product
          // behaved.
          log(
            `[HISTORY_BUNDLE] ${toAdd.length} messages received for ${convoKey.slice(0, 8)}… from ${senderNorm.slice(0, 8)}`
          );
          if (batchAddMessages) {
            // A RESTORE, AND THE WHOLE POINT OF THE DISTINCTION. A member answered this device's
            // ask with its own archive; every message in it has been delivered before, which is why
            // somebody still had it to send. Announcing the last one at every launch is `G2`.
            await batchAddMessages(toAdd, convoKey, 'restore');
          } else {
            for (const item of toAdd) {
              await addMessageToChat(item.senderId, item.content, convoKey, item);
            }
          }
        }

        // 4) Merge what step 1 allowed onto the conversation's rows (`mergeVettedRow`).
        const c = conversations.get(convoKey);
        if (c) {
          const changedIds = new Set<string>();
          // The rows whose BODY an edit replaced - written at rest below.
          const bodyEditedIds = new Set<string>();
          // The proofs a merge took, written at rest with the change they prove.
          const editProofs = new Map<string, RecordedAuthorship>();
          const deleteProofs = new Map<string, RecordedAuthorship>();
          const nextMessages = c.messages.map((existing) => {
            const vetted = vettedBundle.decisions.get(existing.id);
            if (!vetted) return existing;
            const merged = mergeVettedRow(
              existing,
              vetted.entry,
              vetted.decision,
              senderNorm,
              messageReactions.get(existing.id)
            );
            if (!merged.changed) return existing;
            changedIds.add(existing.id);
            if (merged.reactions) messageReactions.set(existing.id, merged.reactions);
            if (merged.bodyEdited) bodyEditedIds.add(existing.id);
            if (merged.editProof) editProofs.set(existing.id, merged.editProof);
            if (merged.deleteProof) deleteProofs.set(existing.id, merged.deleteProof);
            return merged.next;
          });
          // 3) Recount the unread badge against our own watermark, which step 0 may have just
          //    advanced. Step 1 went through the add-path, which counts EVERY incoming message as
          //    unread because it cannot see read state - a message this user already read on
          //    another device is below the watermark and must not raise a badge here.
          //    Clamped to the current value: an open conversation was already zeroed by the
          //    add-path and must never regain a badge, and a genuine new member - whose watermark
          //    is 0 - keeps the full count.
          const mine = readPointFor(c, userId.toLowerCase());
          const stillUnread = countUnreadForUser(nextMessages, mine.stamped, mine.server);
          const nextUnreadCount = Math.min(c.unreadCount ?? 0, stillUnread);
          if (changedIds.size > 0 || nextUnreadCount !== (c.unreadCount ?? 0)) {
            conversations.set(convoKey, {
              ...c,
              messages: nextMessages,
              unreadCount: nextUnreadCount,
            });
            log(
              `[HISTORY_BUNDLE] merged metadata onto ${changedIds.size} message(s), unread ${c.unreadCount ?? 0} -> ${nextUnreadCount}`
            );
            if (storage) {
              for (const msg of nextMessages) {
                if (!changedIds.has(msg.id)) continue;
                try {
                  // The metadata the merge above may have moved. The body is left alone EXCEPT on
                  // a deletion, which must purge it at rest: the tombstone is meant to be all that
                  // survives, and writing the row without it put the original text back on disk -
                  // and on an edit the AUTHOR's own bundle carried, which supersedes it.
                  await storage.updateMessage(
                    msg.id,
                    {
                      reactions: messageReactions.get(msg.id) ?? msg.reactions,
                      serverTimestamp: msg.serverTimestamp,
                      // A tombstone purges the original signed bytes with the body.
                      ...(msg.isDeleted
                        ? {
                            isDeleted: true,
                            content: msg.content,
                            authorship: null,
                            editProof: null,
                            ...(deleteProofs.has(msg.id)
                              ? { deleteProof: deleteProofs.get(msg.id) }
                              : {}),
                          }
                        : {}),
                      ...(!msg.isDeleted && bodyEditedIds.has(msg.id)
                        ? { content: msg.content, editProof: editProofs.get(msg.id) ?? null }
                        : {}),
                      ...(msg.isEdited ? { isEdited: true } : {}),
                      ...(msg.editedAt ? { editedAt: msg.editedAt.getTime() } : {}),
                    },
                    deviceKey()
                  );
                } catch (e) {
                  // Non-blocking: memory already holds the merge, the next bundle restates it.
                  log(
                    `[HISTORY_BUNDLE] merged state of ${msg.id.slice(0, 8)} not persisted: ${String(e)}`
                  );
                }
              }
            }
          }
        }
      }
    } catch (e) {
      // A malformed bundle is ignored, never silently: it is the only trace of a peer that
      // answered a history request with something this device could not apply.
      log(
        `[HISTORY_BUNDLE] ${convoKey.slice(0, 8)}… from ${senderNorm.slice(0, 8)} not applied: ${String(e)}`
      );
    }
    return true;
  }

  // LEGACY FRAME. Taking a reaction back now travels as a `ReactionMsg` with `removed` set, the
  // same frame that placed it. This branch only ever sees entries written to the shared log before
  // that change; no client sends one any more. Removal condition in
  // `docs/wiki/legacy-compatibility.md`.
  if (event === 'remove_reaction' && data.messageId && data.emoji) {
    const reactions = messageReactions.get(data.messageId) || [];
    // Dated with the delivery time, which is the only clock this frame shape carries. It is
    // therefore ordered after every placement that preceded it in the log, which is what it meant.
    const updated = applyReaction(
      reactions,
      senderNorm,
      String(data.emoji),
      deliveryMeta?.queuedCreatedAt ?? Date.now(),
      true
    );
    if (!updated) return true;
    messageReactions.set(data.messageId, updated);

    const c = conversations.get(convoKey);
    if (c) {
      const msgIdx = c.messages.findIndex((m) => m.id === data.messageId);
      if (msgIdx !== -1) {
        const nextMsgs = [...c.messages];
        nextMsgs[msgIdx] = { ...nextMsgs[msgIdx], reactions: updated };
        conversations.set(convoKey, { ...c, messages: nextMsgs });
        if (storage) {
          try {
            await storage.updateMessage(nextMsgs[msgIdx].id, { reactions: updated }, deviceKey());
          } catch {
            // Non-blocking
          }
        }
      }
    }
    return true;
  }

  if ((event === 'pin' || event === 'unpin') && data.messageId) {
    // `at` is the sender's clock, and the merge needs it. A frame from a client too old to send one
    // is dated on receipt: later than anything we hold, which is the right answer for a frame
    // arriving live, and the only one available. See `docs/wiki/legacy-compatibility.md`.
    applyPin(convoKey, String(data.messageId), event === 'pin', Number(data.at) || Date.now());
    return true;
  }

  // Unknown system event - ACK silently to avoid blocking the delivery queue
  return true;
}
