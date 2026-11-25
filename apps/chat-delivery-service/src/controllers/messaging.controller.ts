import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
  Headers,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { QueuedMessage } from '../entities/queued-message.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import {
  MessagingService,
  SendMessageBody,
  AckMessagesBody,
  clientSendRefusal,
  ValidateCommitBody,
} from '../services/messaging.service';
import {
  canonicalUserId,
  sanitizeDevicePairLogValue,
  sanitizeEpoch,
  sanitizeLeafLogValue,
  sanitizeLogValue,
  sanitizeOptionalQueryValue,
  sanitizeQueryValue,
} from '../utils/sanitize';
import { RouteParams } from '../common/route-params';
import { reactionCollapseId } from '../services/push-payload';

/** The longest reacted-to message id `notify-reaction` hashes: a uuid is 36, a server row id shorter. */
export const REACTION_MESSAGE_ID_MAX_LENGTH = 128;

/**
 * How far ahead of this server a reaction's instant may be and still be forwarded (`notify-reaction`):
 * a day covers any phone's clock drift, and refuses a stamp no real reaction could carry.
 */
export const REACTION_AT_MAX_AHEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Commits one user may submit per minute on `POST /mls/commit`, across all their devices.
 *
 * SIZED ABOVE THE LARGEST LEGITIMATE BURST, NOT AT THE AVERAGE. Key-group external joins run at
 * ~77 a day across the whole estate (2026-10-22), but one device that restores, or rejoins after a
 * lost state, commits once per group in quick succession - and a client submits its commits one at
 * a time, each under its MLS mutex and after its own round-trip. 600 a minute is ten a second per
 * user, which that serial path does not reach on any network a phone sits on, while still bounding
 * what a crafted stream costs (a key group's external commit asks social-service once per commit).
 * The production maximum per user and minute is owed (`mls_commit_log`, grouped by sender device
 * and minute) and is what this number is checked against: see the channel-encryption protocol,
 * "WP-21, and the gate it had nowhere to live".
 */
export const MLS_COMMIT_LIMIT_PER_MINUTE = 600;

/**
 * The classes the ENTRANT names its own entry no member made as (`EntrantEntryKind` on the client;
 * slice 1 of the admission fix-forward, docs/wiki/protocols/admission-fix-forward.md). Their
 * `entrant` is the authenticated caller, never the body: a device can only speak for itself.
 */
const ENTRANT_UNINVITED_ENTRY_KINDS: readonly string[] = [
  'entrant-direct-peer',
  'entrant-unhonoured-seat',
  'entrant-not-pending',
  'entrant-no-device-row',
];

/** The classes a client may name an uninvited entry as (`UninvitedEntryKind` on the client). */
const UNINVITED_ENTRY_KINDS: readonly string[] = [
  'new-person',
  'returning',
  'direct-peer',
  // A never-seen device of a member that entered a conversation by its own commit (2026-10-27).
  'unvouched-device',
  ...ENTRANT_UNINVITED_ENTRY_KINDS,
];

/** The kinds a device decides from its own record of the group, so their line prints `watched_from`. */
const EVIDENCED_UNINVITED_ENTRY_KINDS: readonly string[] = ['new-person', 'returning'];

/**
 * An epoch field of an uninvited-entry report as it is printed AND stored: a safe integer's digits
 * (at most 17 characters with the sign), `unstated` when absent, `invalid` for anything else - a
 * digit STRING included, since the client sends a JSON number. Never the generic sanitizer's
 * 128-character string: the columns are VARCHAR(32), and an oversized value would make every report
 * of the entry fail its INSERT (migration 053).
 */
export function uninvitedEntryEpochField(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'unstated';
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : 'invalid';
}

/** MLS message send, commit validation, welcome delivery, history, and ACK. */
@RouteParams({ groupId: 'uuid', userId: 'opaque', deviceId: 'opaque' })
@Controller()
export class MessagingController {
  private readonly logger = new Logger(MessagingController.name);

  constructor(private readonly messagingService: MessagingService) {}

  @UseGuards(HeaderAuthGuard)
  @Post('mls/send')
  async sendMessage(@Body() body: SendMessageBody, @Headers('x-user-id') authUserId?: string) {
    // `HeaderAuthGuard` has already required the header, so a caller is always named here.
    const caller = authUserId ?? '';
    const refusal = clientSendRefusal(body, caller);
    if (refusal) {
      // ONE line, every caller-supplied value sanitised: the refusal is the event, and the response
      // body carries the code only.
      // A public handshake frame on the send route is no client's ordinary traffic - every sender
      // seals application frames privately - so it is logged as the accusation it is.
      const line = `[SEND] REJECT ${refusal.error} user=${sanitizeLogValue(caller)} ${refusal.detail}`;
      if (refusal.error === 'public_frame_refused') this.logger.error(line);
      else this.logger.warn(line);
      const response = { error: refusal.error, message: 'this send is not accepted' };
      throw refusal.status === 403
        ? new ForbiddenException(response)
        : new BadRequestException(response);
    }
    return this.messagingService.sendMessage(body, authUserId);
  }

  /**
   * A client's commit, handed to the gate as the fields the web client sends (`submitCommit`) and
   * nothing else: {@link foregroundCommitBody}. A Welcome travels WITH a commit only on the
   * background re-add (`POST mls/push/send-welcome-and-commit`); passed through here, a raw body
   * would store one through a door nobody declared. Epoch-gated (`MessagingService.validateCommit`)
   * and rate-limited per user.
   *
   * The limit sits on the route and not on the service because the background Welcome
   * (`push.controller.ts`) reaches the same gate under a PushSecret, one commit per Welcome, and is
   * not a stream a client chooses. A refusal is the throttler's `429`, before any work: the epoch
   * has not moved, and the client rolls its staged commit back on that status (`BaseMlsService`).
   */
  @UseGuards(HeaderAuthGuard, UserThrottlerGuard)
  @Throttle({ default: { limit: MLS_COMMIT_LIMIT_PER_MINUTE, ttl: 60_000 } })
  @Post('mls/commit')
  async validateCommit(
    @Body() body: ForegroundCommitBody,
    @Headers('x-user-id') authUserId?: string
  ) {
    return this.messagingService.validateCommit(foregroundCommitBody(body), authUserId);
  }

  /**
   * Rung-1 replay: ordered commits with `baseEpoch >= sinceEpoch` so a device that fell behind
   * catches up without dropping its state. Membership-gated in the service.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/commits/:groupId')
  async getCommitsSince(
    @Headers('x-user-id') authUserId: string | undefined,
    @Param('groupId') groupId: string,
    @Query('sinceEpoch') sinceEpochRaw?: string
  ) {
    const sinceEpoch = sanitizeEpoch(sinceEpochRaw, 'sinceEpoch');
    if (!authUserId) {
      throw new BadRequestException('missing x-user-id');
    }
    return this.messagingService.getCommitsSince(groupId, sinceEpoch, authUserId);
  }

  /**
   * When the server accepted the commit built on `baseEpoch` (`mls_commit_log.createdAt`), for a
   * line a device derives from that commit - dated by the commit, never by when the device merged
   * it. `{ acceptedAt: null }` when the log holds no such row. Membership-gated in the service.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/commits/:groupId/accepted-at')
  async getCommitAcceptedAt(
    @Headers('x-user-id') authUserId: string | undefined,
    @Headers('x-canari-device') deviceId: string | undefined,
    @Param('groupId') groupId: string,
    @Query('baseEpoch') baseEpochRaw?: string
  ) {
    // Who is asking before what: an unauthenticated request is refused as such, whatever it asked
    // of a well-formed path (a `groupId` that is not a uuid never reaches a handler: `@RouteParams`).
    if (!authUserId) {
      throw new BadRequestException('missing x-user-id');
    }
    const baseEpoch = sanitizeEpoch(baseEpochRaw, 'baseEpoch');
    return this.messagingService.getCommitAcceptedAt(
      groupId,
      baseEpoch,
      authUserId,
      sanitizeOptionalQueryValue(deviceId, 'x-canari-device')
    );
  }

  /**
   * When the REQUESTER'S OWN seat in a group was removed (`{ removedAt }`, `null` when nothing
   * removed it) - the date of the "you were removed" line a device writes when it learns of its
   * removal from an evidence that carries no time. Reads only the requester's own rows, so it is
   * not membership-gated: a removed device is exactly who asks.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/groups/:groupId/own-removal')
  async getOwnRemovalAt(
    @Headers('x-user-id') authUserId: string | undefined,
    @Headers('x-canari-device') deviceId: string | undefined,
    @Param('groupId') groupId: string
  ) {
    if (!authUserId) {
      throw new BadRequestException('missing x-user-id');
    }
    return this.messagingService.getOwnRemovalAt(
      groupId,
      authUserId,
      sanitizeOptionalQueryValue(deviceId, 'x-canari-device')
    );
  }

  /**
   * External-join base (Phase 4): the latest GroupInfo for a group, so an authorized member lacking
   * MLS state can build an external commit to (re)join. Membership-gated in the service.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/group-info/:groupId')
  async getGroupInfo(
    @Headers('x-user-id') authUserId: string | undefined,
    @Param('groupId') groupId: string,
    @Query('deviceId') deviceIdRaw?: string
  ) {
    if (!authUserId) {
      throw new BadRequestException('missing x-user-id');
    }
    // The asking device's seat travels WITH the base when the device names itself (`readDeviceSeat`).
    const deviceId = sanitizeOptionalQueryValue(deviceIdRaw, 'deviceId');
    // "Nothing stored" is answered as JSON, never as a bare `null`: Nest sends a handler's `null` as
    // an EMPTY body with no content type, which the client cannot tell from a captive portal's empty
    // 2xx - so it read "no base" as an unparseable answer. `{ groupInfo: null }` is what every client,
    // old or new, already reads as "no base".
    return (
      (await this.messagingService.getGroupInfo(groupId, authUserId, deviceId)) ?? {
        groupInfo: null,
      }
    );
  }

  /**
   * Refreshes the stored GroupInfo for a group (the committer calls this after each accepted commit;
   * a new group's first member-add is itself a commit). Membership-gated; monotonic (a lower
   * baseEpoch is ignored).
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls/group-info/:groupId')
  async storeGroupInfo(
    @Headers('x-user-id') authUserId: string | undefined,
    @Param('groupId') groupId: string,
    @Body() body: { groupInfo: string; baseEpoch: number }
  ) {
    if (!authUserId) {
      throw new BadRequestException('missing x-user-id');
    }
    if (typeof body?.groupInfo !== 'string' || !Number.isFinite(body?.baseEpoch)) {
      throw new BadRequestException('groupInfo (base64) and baseEpoch are required');
    }
    return this.messagingService.storeGroupInfo(
      groupId,
      authUserId,
      body.groupInfo,
      body.baseEpoch
    );
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/welcome')
  async sendWelcome(
    @Headers('x-user-id') authUserId: string | undefined,
    @Body()
    body: {
      targetDeviceId: string;
      targetUserId?: string;
      senderUserId?: string;
      welcomePayload: string;
      ratchetTreePayload?: string;
      groupId: string;
    }
  ) {
    return this.messagingService.sendWelcome(authUserId, body);
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/welcome-request')
  async notifyWelcomeRequest(
    @Headers('x-user-id') authUserId: string | undefined,
    @Body()
    body: {
      groupId: string;
      requesterUserId: string;
      requesterDeviceId: string;
      selfJoinIfNobody?: boolean;
    }
  ) {
    return this.messagingService.notifyWelcomeRequest(authUserId, {
      groupId: body.groupId,
      requesterUserId: body.requesterUserId,
      requesterDeviceId: body.requesterDeviceId,
      selfJoinIfNobody: body.selfJoinIfNobody === true,
    });
  }

  /**
   * A client stating that a frame's delivery ENVELOPE named another sender than the one OpenMLS
   * verified it against (channel-encryption section 21, WP-G2-1).
   *
   * THE MEASUREMENT BEFORE A REFUSAL. The client refuses nothing yet - the user's decision of
   * 2026-09-28 is to read production first, since a legitimate disagreement nobody foresaw would lose
   * messages if refused blind - and a client's console is collected nowhere, so this line is the
   * whole of the measurement. It stores nothing, for the reason `mls/push/unavailable` gives: the
   * question is "does this happen, on which path, for whom", which a WARN line and a date answer.
   *
   * Every field is printed through `sanitizeLogValue`, so a client cannot write a newline into the
   * log and forge a line of its own; a value outside the allowlist prints as `invalid`, which is
   * itself worth reading. The reporter is the authenticated user, never a field of the body.
   */
  @UseGuards(HeaderAuthGuard, UserThrottlerGuard)
  @Post('mls/sender-mismatch')
  reportSenderMismatch(
    @Headers('x-user-id') authUserId: string | undefined,
    @Headers('x-canari-device') reporterDeviceId: string | undefined,
    @Body()
    body: {
      groupId?: unknown;
      path?: unknown;
      kind?: unknown;
      envelopeUserId?: unknown;
      envelopeDeviceId?: unknown;
      verifiedIdentity?: unknown;
    }
  ): { recorded: true } {
    this.logger.warn(
      `[SENDER_MISMATCH] reporter=${sanitizeDevicePairLogValue(authUserId, reporterDeviceId)} ` +
        `group=${sanitizeLogValue(body.groupId)} path=${sanitizeLogValue(body.path)} ` +
        `kind=${sanitizeLogValue(body.kind)} ` +
        `envelope=${sanitizeDevicePairLogValue(body.envelopeUserId, body.envelopeDeviceId, 'none')} ` +
        `verified=${sanitizeLeafLogValue(body.verifiedIdentity, 'unreadable')}`
    );
    return { recorded: true };
  }

  /**
   * A client stating that a NEW PERSON entered one of its conversations by their own commit - an
   * external commit signed by the very device it admitted, from a user who held no leaf before it.
   * No member added them; the group info this service serves and the commit it accepted are all
   * that let them in.
   *
   * A MEASUREMENT, exactly as `mls/sender-mismatch`: such an entry is either a user who lost every
   * leaf rejoining by themselves, or one nobody wanted. The reporting device says what it can tell
   * (`kind`, an allowlist): `returning` - the device PROVES, from trees it accepted itself, that
   * this user held a leaf of this group before (never this service's word, owner 2026-11-14);
   * `direct-peer` - the 1:1 conversation's own other person, whom opening it already chose;
   * `new-person` - NOT PROVEN a member by that device. The line carries it so the classes are
   * counted apart, and `watched_from` - the first epoch the device's record of the group covers - so
   * a `new-person` from a device that was not there yet when a member left is told apart from one
   * that watched the whole time.
   *
   * ONE LINE PER ENTRY AND KIND, NOT PER REPORTER: every member device sees the same commit and
   * reports it, so the count is deduplicated on (group, entrant, epoch, kind) - an entry is one
   * commit, and a later entry of the same device is another. Each device decides from what IT saw,
   * so two members may disagree - one proving a return, one that cannot - and both lines are
   * printed: the disagreement measures what devices lack.
   *
   * THE COUNT IS A TABLE (`uninvited_entries`, migration 053). The first report of an entry under a
   * kind writes its row and prints the WARN line; a repeat finds the row, by any replica and after
   * any deploy. It used to be a set in this process's memory, so every deploy reset it and a reading
   * of production covered only the hours since the last one.
   *
   * A ROW THAT COULD NOT BE WRITTEN IS LOST TO THE COUNT, AND SAID SO ON THE SERVER ONLY. It is
   * printed at ERROR with all its evidence (`NOT COUNTED`) and answered `{ recorded: false }` with a
   * 2xx. No client reports an entry twice (once per app session, and a failure is never retried), so a
   * 503 would buy nothing but a warning in the reporter's console for a fault that is the server's
   * and is already accused here. Only a database failure reaches that branch: every value is
   * classified to fit its column before the INSERT ({@link uninvitedEntryEpochField}).
   *
   * THE ENTRANT SPEAKS TOO (slice 1 of the admission fix-forward): a device whose own external
   * commit was accepted on a tree holding no leaf of its account reports it under an `entrant-*`
   * kind - the path it took, classified where it decided to commit. Same table, same
   * `(group, entrant, epoch)`, so each member's `new-person` row pairs with the entrant's own row,
   * and an unpaired one is an entry no client at that build made. Its `entrant` is the reporter
   * itself, read from the authenticated headers: the body cannot name anyone else.
   *
   * The reporter is the authenticated user and device and a MEMBER of the group (anyone else is
   * refused, 403, as `mls/integrity-finding`). Every field goes through `sanitizeLogValue`.
   */
  @UseGuards(HeaderAuthGuard, UserThrottlerGuard)
  @Post('mls/uninvited-entry')
  async reportUninvitedEntry(
    @Headers('x-user-id') authUserId: string | undefined,
    @Headers('x-canari-device') reporterDeviceId: string | undefined,
    @Body()
    body: {
      groupId?: unknown;
      entrant?: unknown;
      epoch?: unknown;
      keyFingerprint?: unknown;
      kind?: unknown;
      watchedFromEpoch?: unknown;
    }
  ): Promise<{ recorded: boolean }> {
    const reporter = sanitizeDevicePairLogValue(authUserId, reporterDeviceId);
    const groupId = typeof body.groupId === 'string' ? body.groupId : '';
    if (
      !groupId ||
      !authUserId ||
      !(await this.messagingService.isGroupMember(groupId, authUserId))
    ) {
      this.logger.warn(
        `[UNINVITED_ENTRY] REJECT not-a-member reporter=${reporter} group=${sanitizeLogValue(body.groupId)}`
      );
      throw new ForbiddenException({
        error: 'not-a-member',
        message: 'not a member of this group',
      });
    }
    // The numeric fields, printed as their digits; anything else is `invalid` like every field.
    const epoch = uninvitedEntryEpochField(body.epoch);
    const group = sanitizeLogValue(groupId);
    const kind =
      body.kind === undefined || body.kind === null
        ? 'unstated'
        : UNINVITED_ENTRY_KINDS.includes(body.kind as string)
          ? (body.kind as string)
          : 'invalid';
    // An entrant's own word names the caller, whatever the body says - in the canonical form
    // (`canonicalDeviceKey`: the user half trimmed and lowercased) a member's report of the same
    // entry is keyed by, so the two rows pair whatever case the header carried.
    const entrant = ENTRANT_UNINVITED_ENTRY_KINDS.includes(kind)
      ? sanitizeDevicePairLogValue(authUserId.trim().toLowerCase(), reporterDeviceId)
      : sanitizeLeafLogValue(body.entrant);
    // `none` is the device's own answer (it holds no record of the group); `unstated` is a build
    // that does not send it; `-` is a kind the device decides without its record.
    const watchedFrom = !EVIDENCED_UNINVITED_ENTRY_KINDS.includes(kind)
      ? '-'
      : body.watchedFromEpoch === null
        ? 'none'
        : uninvitedEntryEpochField(body.watchedFromEpoch);
    const evidence =
      `kind=${kind} reporter=${reporter} group=${group} entrant=${entrant} ` +
      `epoch=${epoch} key=${sanitizeLogValue(body.keyFingerprint)} watched_from=${watchedFrom}`;
    let first: boolean;
    try {
      first = await this.messagingService.claimUninvitedEntry({
        groupId,
        entrantUserDevice: entrant,
        epoch,
        kind,
        watchedFrom,
      });
    } catch (e) {
      this.logger.error(
        `[UNINVITED_ENTRY] NOT COUNTED ${evidence} - the row could not be written: ` +
          String(e).replace(/\s+/g, ' ').slice(0, 160)
      );
      return { recorded: false };
    }
    if (!first) {
      this.logger.debug(
        `[UNINVITED_ENTRY] repeat kind=${kind} reporter=${reporter} group=${group} entrant=${entrant} epoch=${epoch} - already counted`
      );
      return { recorded: true };
    }
    this.logger.warn(`[UNINVITED_ENTRY] ${evidence}`);
    return { recorded: true };
  }

  /**
   * A client stating it saw what a private conversation must never show: two trees at one epoch
   * (`fork`, a frame whose signed epoch fingerprint is not the receiver's), or restored history whose
   * author signature does not verify (`forged-history`). The UI comes later; this ERROR line is where
   * the event is read today, since a client's console is collected nowhere. Protocol:
   * history-reconciliation, "Restored history carries its author's signature", and mls-protocol,
   * "Fork detection".
   *
   * Stores nothing, like `sender-mismatch`. Every field goes through `sanitizeLogValue`, `kind` is
   * an allowlist and `epoch` a non-negative integer, so no body can write a line of its own.
   *
   * WHAT IS ESTABLISHED AND WHAT IS CLAIMED. The reporter is the authenticated user and device and a
   * MEMBER of the group (anyone else is refused, 403) - those are facts. The `peer` it names is only
   * its claim, and logged as `claimedPeer`. The level follows the client's own, read from the TYPED
   * `proven` field and never from `detail` (free text): `proven: false` (a fork it could not
   * attribute) is a warn, as in mls-core; `true` is ERROR, and so is a report carrying no boolean.
   */
  @UseGuards(HeaderAuthGuard, UserThrottlerGuard)
  @Post('mls/integrity-finding')
  async reportIntegrityFinding(
    @Headers('x-user-id') authUserId: string | undefined,
    @Headers('x-canari-device') reporterDeviceId: string | undefined,
    @Body()
    body: {
      kind?: unknown;
      groupId?: unknown;
      epoch?: unknown;
      peer?: unknown;
      detail?: unknown;
      proven?: unknown;
    }
  ): Promise<{ recorded: true }> {
    const reporter = sanitizeDevicePairLogValue(authUserId, reporterDeviceId);
    const groupId = typeof body.groupId === 'string' ? body.groupId : '';
    if (
      !groupId ||
      !authUserId ||
      !(await this.messagingService.isGroupMember(groupId, authUserId))
    ) {
      this.logger.warn(
        `[INTEGRITY] REJECT not-a-member reporter=${reporter} group=${sanitizeLogValue(body.groupId)}`
      );
      throw new ForbiddenException({
        error: 'not-a-member',
        message: 'not a member of this group',
      });
    }
    const kind = body.kind === 'fork' || body.kind === 'forged-history' ? body.kind : 'invalid';
    const epoch =
      body.epoch === undefined || body.epoch === null
        ? 'none'
        : Number.isSafeInteger(body.epoch) && (body.epoch as number) >= 0
          ? String(body.epoch)
          : 'invalid';
    const proven = typeof body.proven === 'boolean' ? String(body.proven) : 'invalid';
    const line =
      `[INTEGRITY] kind=${kind} reporter=${reporter} group=${sanitizeLogValue(groupId)} ` +
      `epoch=${epoch} claimedPeer=${sanitizeLeafLogValue(body.peer)} proven=${proven} ` +
      `detail=${sanitizeLogValue(body.detail)}`;
    if (body.proven === false) this.logger.warn(line);
    else this.logger.error(line);
    return { recorded: true };
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/base-refresh-request')
  /**
   * Asks a member to republish the group's external-join base. Its own route rather than a flag on
   * the welcome request, because it asks for something else entirely: a read-only publish that
   * takes no lock and changes no epoch, against a Welcome that mutates the tree.
   */
  async notifyBaseRefreshRequest(
    @Headers('x-user-id') authUserId: string | undefined,
    @Body()
    body: { groupId: string; requesterUserId: string; requesterDeviceId: string }
  ) {
    return this.messagingService.notifyBaseRefreshRequest(authUserId, body);
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/history-request')
  async notifyHistoryRequest(
    @Headers('x-user-id') authUserId: string | undefined,
    @Body()
    body: {
      groupId: string;
      requesterUserId: string;
      requesterDeviceId: string;
      /** Member keys (`userId:deviceId`) already heard from - see `NotifyHistoryRequestBody`. */
      exclude?: string[];
    }
  ) {
    return this.messagingService.notifyHistoryRequest(authUserId, body);
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/history/batch')
  async getHistoryBatch(
    @Body()
    body: { groups?: { groupId: string; after?: string; limit?: number; until?: string }[] },
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-canari-device') headerDeviceId?: string
  ) {
    return this.messagingService.getHistoryBatch(body?.groups ?? [], headerUserId, headerDeviceId);
  }

  /**
   * One history page. The body stays a bare array - the shape every deployed client already parses -
   * and the stream head travels in `X-History-Head`, which an older client simply ignores.
   *
   * The head is the upper bound the caller passes back as `until` for the rest of its walk, so a
   * replay never reads rows appended while it was running: those belong to the delivery queue.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/history/:groupId')
  async getHistory(
    @Param('groupId') groupId: string,
    @Res({ passthrough: true }) res: Response,
    @Query('after') after?: string,
    @Query('limit') limitRaw?: string,
    @Query('until') until?: string,
    @Headers('x-user-id') headerUserId?: string,
    /**
     * The client's own device id, self-asserted and DIAGNOSTIC ONLY - nothing branches on it, and
     * it cannot refuse the request. It is what lets a burst of walks over one group be attributed
     * to a device rather than to an account with several. See `historyRequester`.
     */
    @Headers('x-canari-device') headerDeviceId?: string
  ): Promise<Record<string, unknown>[]> {
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    const { rows, head } = await this.messagingService.getHistory(
      groupId,
      after,
      headerUserId,
      Number.isFinite(limit) ? limit : undefined,
      until,
      headerDeviceId
    );
    if (head) res.setHeader('X-History-Head', head);
    return rows;
  }

  @UseGuards(HeaderAuthGuard)
  @Get('mls/messages/:userId/:deviceId')
  async fetchMessages(
    @Param('userId') userId: string,
    @Param('deviceId') deviceId: string,
    @Query('limit') limitRaw?: string,
    @Query('after') after?: string,
    @Headers('x-user-id') headerUserId?: string,
    // What the fetching session declares, as on its socket (history-answer-addressing, rule 6).
    @Query('caps') caps?: string
  ): Promise<QueuedMessage[]> {
    const limit = limitRaw ? parseInt(limitRaw, 10) : 500;
    return this.messagingService.fetchMessages(
      userId,
      deviceId,
      headerUserId,
      Number.isFinite(limit) ? limit : 500,
      after,
      caps
    );
  }

  @UseGuards(HeaderAuthGuard)
  @Post('mls/messages/ack')
  async acknowledgeMessages(
    @Body() body: AckMessagesBody,
    @Headers('x-user-id') headerUserId?: string
  ) {
    return this.messagingService.acknowledgeMessages(body, headerUserId);
  }

  /**
   * Notifies the author of a message that someone reacted to it.
   *
   * NOTHING OF THE MESSAGE ITSELF CROSSES THIS ENDPOINT, and that is the point of its shape.
   * It used to take a `messagePreview` - 80 characters of the DECRYPTED message, computed by the
   * reacting client - and compose `<actor> a réagi <emoji> à « <preview> »` from it. That sentence
   * then travelled in the FCM data map AND in the APNs `alert.body`, so plaintext from an
   * end-to-end encrypted conversation reached this server, Google and Apple, on every reaction.
   * The docstring above it asserted the opposite ("the server never sees MLS plaintext") three
   * lines before the field that broke it. Nothing logged it, so it was in transit only - which is
   * not a defence, it is the extent of the damage.
   *
   * The recipient is the message's AUTHOR, so the device already holds the message: it needs an
   * id, not a copy. The push therefore carries `messageId` and the device renders the reaction
   * against its own copy, in its own language.
   *
   * WHY THE WIRE TYPE IS STILL `social`. `minClientVersion` is 0.13.0 and the store rollout has
   * not reached devices, so clients that predate this change are receiving these pushes right now.
   * An unknown `type` falls through their dispatch chain into the MLS decrypt ladder - noise on
   * every old phone, for a push with no ciphertext in it. The type stays, `reaction: 'true'`
   * discriminates, and `body` carries a GENERIC sentence with no message content: an old client
   * renders it exactly as it renders one today minus the preview, and a new one ignores it.
   * See `docs/wiki/legacy-compatibility.md` for when the generic body may be dropped.
   *
   * Guard: no notification if the reactor is the message author (cross-device own-action - the
   * user already knows what they did).
   *
   * ONLY A MEMBER OF THE CONVERSATION MAY RING ITS AUTHOR (re-review of #2358): the caller must be
   * an admitted member of the group, or a reader of the salon (`channel_<id>`), checked before
   * anything is pushed - {@link MessagingService.assertCallerReactsIn}. A stranger, a removed member
   * or an unknown id is the 403 `NOT_A_MEMBER`, a seat awaiting admission the 409.
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls/notify-reaction')
  async notifyReaction(
    @Headers('x-user-id') callerId: string,
    @Body()
    body: {
      groupId: string;
      targetSenderId: string;
      emoji: string;
      /** The reacted-to message, so the device can find its own copy. Never its content. */
      messageId?: string;
      actorName: string;
      /**
       * The reaction's own instant (`ReactionMsg.at`, the reactor's clock), so the author's device
       * recognises a push and a WebSocket frame for the SAME reaction (Android's `alreadyPosted`; on
       * iOS the `collapseId` derived from it). Absent from a client predating it: the push then
       * carries neither, as before.
       */
      at?: number;
    }
  ): Promise<{ sent: number; failed: number }> {
    if (!callerId) throw new BadRequestException('x-user-id header required');
    const groupId = sanitizeQueryValue(body?.groupId, 'groupId');
    await this.messagingService.assertCallerReactsIn(groupId, canonicalUserId(callerId));

    // Never notify if actor == message author (cross-device own-reaction)
    if (!body.targetSenderId || callerId === body.targetSenderId) {
      return { sent: 0, failed: 0 };
    }

    const emoji = String(body.emoji ?? '').slice(0, 20);
    const actor = String(body.actorName ?? callerId).slice(0, 100);
    // Forwarded only as a plausible instant: a positive integer of ms no later than a day ahead of
    // this server (a reactor's clock may run fast, never by days). Anything else is a client's bug,
    // never a stamp - and a stamp is an identity on the author's devices, so a wild one is refused
    // rather than allowed to collide with or outlive the reactions it would be compared with.
    const at = Number(body.at);
    // A message id is a server row id or a client uuid, never long: one past the bound is a client's
    // bug, and hashing it (`reactionCollapseId` walks every character) would let a caller buy CPU
    // with a body. Refused by length, said once, and the push then carries the stamp alone.
    const rawMessageId = typeof body.messageId === 'string' ? body.messageId : '';
    const messageId = rawMessageId.length <= REACTION_MESSAGE_ID_MAX_LENGTH ? rawMessageId : '';
    if (rawMessageId && !messageId) {
      this.logger.warn(
        `[notify-reaction] a message id of ${rawMessageId.length} characters from ${sanitizeLogValue(callerId)} was not used: no collapse id`
      );
    }
    const atIsPlausible =
      Number.isSafeInteger(at) && at > 0 && at <= Date.now() + REACTION_AT_MAX_AHEAD_MS;
    // The collapse id needs the reacted-to message (`reactionCollapseId`: never the conversation).
    // A reactor that names none gets the stamp alone - Android's dedup needs no more.
    const stamp = atIsPlausible
      ? {
          at: String(at),
          ...(messageId
            ? { collapseId: reactionCollapseId(messageId, canonicalUserId(callerId)) }
            : {}),
        }
      : {};
    if (body.at !== undefined && !('at' in stamp)) {
      this.logger.warn(
        `[notify-reaction] an implausible reaction instant from ${sanitizeLogValue(callerId)} was not forwarded: ${sanitizeLogValue(String(body.at))}`
      );
    }

    // Legacy body only - carries the emoji and the actor, never the message. Clients that
    // understand `reaction` compose their own from `strings.xml` / `Localizable.strings`.
    const legacyBody = `${actor} a réagi ${emoji} à votre message`;

    return this.messagingService.sendPushToUser(body.targetSenderId, actor, legacyBody, {
      type: 'social',
      reaction: 'true',
      deepLink: `fr.emse.canari://chat/${groupId}`,
      groupId,
      messageId,
      emoji,
      // The ACTOR, so the device can fetch their avatar - the message path needs it and the
      // social path never carried one.
      senderId: callerId,
      ...stamp,
    });
  }
}

/** What `POST /mls/commit` accepts: a commit, never the Welcome only the background re-add carries. */
export type ForegroundCommitBody = Omit<ValidateCommitBody, 'welcome'>;

/**
 * The allowlist of `POST /mls/commit`: the fields `submitCommit` sends, copied by name. Anything
 * else in the request body - `welcome` first - never reaches the gate. An absent field stays absent.
 */
export function foregroundCommitBody(body: ForegroundCommitBody): ForegroundCommitBody {
  const out: ForegroundCommitBody = {
    groupId: body.groupId,
    deviceId: body.deviceId,
    baseEpoch: body.baseEpoch,
  };
  if (body.proto !== undefined) out.proto = body.proto;
  if (body.senderId !== undefined) out.senderId = body.senderId;
  if (body.excludeDeviceIds !== undefined) out.excludeDeviceIds = body.excludeDeviceIds;
  if (body.groupInfo !== undefined) out.groupInfo = body.groupInfo;
  if (body.admits !== undefined) out.admits = body.admits;
  if (body.invitationSeatGeneration !== undefined) {
    out.invitationSeatGeneration = body.invitationSeatGeneration;
  }
  if (body.removes !== undefined) out.removes = body.removes;
  return out;
}
