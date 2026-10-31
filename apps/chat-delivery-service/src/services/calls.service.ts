import {
  Injectable,
  Logger,
  ForbiddenException,
  ServiceUnavailableException,
  Inject,
  BadRequestException,
  GoneException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { callsAllowedFor, GroupMember } from '../entities/group-member.entity';
import { cutUserId } from '../utils/log-repeat';
import { PushToken } from '../entities/push-token.entity';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { ApnsVoipService } from './apns-voip.service';
import { isBlockedBetween } from '../utils/user-blocks';
import { RefusalCode } from '../utils/refusal-codes';
import { readCallsMode } from '../utils/calls-mode';
import { ADMITTED_SEAT, callerSeatStanding, refuseAwaitingSeat } from '../utils/group-membership';
import { voipRingPayload } from './call-ring-payload';
import { incomingCallAlertBody } from './push-payload';
import {
  METER_TIMEOUT_MS,
  TurnMeterUnavailableError,
  TurnUsageMeter,
} from './turn-usage-meter.service';

/** The TURN budget when `CLOUDFLARE_TURN_MONTHLY_BUDGET_GB` is unset, in GB (Cloudflare's free tier is ~1000 GB). */
export const DEFAULT_TURN_BUDGET_GB = 950;

/**
 * The month's TURN budget as configured. `default`: the variable is unset or empty. `configured`:
 * a whole number of GB, `0` INCLUDED - the owner's decision of 2026-10-21: `0` means calls stay
 * open but are STUN only, never relayed. `invalid`: anything else, read as 0 (the closed direction:
 * a value nobody can read must not spend money) and logged at error wherever it is used.
 */
export type TurnBudget =
  | { gb: number; source: 'default' | 'configured' }
  | { gb: 0; source: 'invalid'; raw: string };

/** Reads `CLOUDFLARE_TURN_MONTHLY_BUDGET_GB`; see {@link TurnBudget}. */
export function readTurnBudget(raw: string | undefined): TurnBudget {
  const value = raw?.trim() ?? '';
  if (value === '') return { gb: DEFAULT_TURN_BUDGET_GB, source: 'default' };
  // Digits AND a safe integer: 400 digits pass the pattern and read as Infinity, a budget no
  // reading can reach.
  if (/^\d+$/.test(value) && Number.isSafeInteger(Number(value))) {
    return { gb: Number(value), source: 'configured' };
  }
  return { gb: 0, source: 'invalid', raw: value };
}

/** How often the TURN meter report runs while calls are open: hourly, like the service's others. */
const TURN_METER_REPORT_MS = 60 * 60 * 1000;

/** Delay of the first report after boot, so a redeploy (more often than hourly) still reports. */
const TURN_METER_FIRST_REPORT_MS = 60_000;

/** ICE server entry returned to WebRTC clients. */
export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * Why `ice-servers` withheld TURN. Typed, and carried in a 200: a direct call needs no relay, so
 * neither reason refuses the call - each only removes the relay leg.
 * - `TURN_BUDGET_REACHED`: the month's metered relay egress reached the budget.
 * - `TURN_METER_UNAVAILABLE`: the meter could not be read, so no budget stands behind a credential.
 */
/**
 * Why TURN was withheld. `TURN_DISABLED` is CONFIGURATION (a budget of 0, or a value read as 0),
 * never a passing state: the client must not word it as "unavailable right now".
 */
export type TurnUnavailableCode =
  | 'TURN_BUDGET_REACHED'
  | 'TURN_METER_UNAVAILABLE'
  | 'TURN_DISABLED';

/** Response shape for `GET /api/calls/ice-servers`. */
export interface IceServersResponse {
  iceServers: IceServerConfig[];
  /** Whether `iceServers` carries a relay; when not, the typed reason. */
  turn: { status: 'available' } | { status: 'unavailable'; code: TurnUnavailableCode };
}

/**
 * Cloudflare's public STUN server: free, no credential, nothing relayed. What `ice-servers` answers
 * when TURN is withheld, so a call between two reachable devices still finds its direct path.
 */
const STUN_ONLY: IceServerConfig[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

/** Response shape for `POST /api/calls/initiate`. */
export interface InitiateCallResponse {
  /** UUID identifying the WebRTC room in call-service. */
  roomId: string;
  /** Short-lived JWT (5 min) proving this user is allowed to join `roomId`. */
  roomToken: string;
  /**
   * How long the callee may still answer, in milliseconds. The caller stops ringing after it and
   * relays it in the MLS invite, so both ends ring for the window THIS server enforces.
   */
  ringTimeoutMs: number;
}

/**
 * What `initiate` records about a room, read back by `room-token`. It is the only link between a
 * room id and the conversation it was opened in: without it, any member of ANY group could obtain
 * a valid token for a room id they had learnt, signed for their own group.
 */
interface CallRoomBinding {
  groupId: string;
  /** The user who opened the room: the only one who may open its ring window. */
  callerId: string;
}

/*
 * The ring window lives in its OWN key, `call:room:<id>:answer_by`: epoch ms on THIS server's clock
 * after which no callee is issued a token. Absent until the caller's `POST /calls/ring`, so the
 * window starts when the ringing does, not when the caller began preparing (ICE servers, a first
 * microphone prompt, key derivation, the signalling join all come in between). A key of its own is
 * what makes "opens once" ATOMIC: one `SET NX`, no read-then-write a concurrent ring could race,
 * and the binding is never rewritten, so its TTL is never restarted.
 */

/** Stored in Redis while a user device is actively in a call. */
export interface UserCallPresence {
  deviceId: string;
  callId?: string;
  groupId?: string;
  updatedAt: number;
}

/** Response shape for `GET /api/calls/sibling-status`. */
export interface SiblingCallStatusResponse {
  active: boolean;
  deviceId?: string;
  callId?: string;
  groupId?: string;
}

const USER_CALL_PRESENCE_TTL_SEC = 2 * 60 * 60;
/** The longest call a room binding outlives: past it the room id names nothing. */
const MAX_CALL_SEC = 4 * 60 * 60;

/**
 * THE ring window: how long a callee may answer. The single source - the caller's timer, the
 * callee's timer (via the MLS invite) and the `room-token` refusal all read this one value.
 */
export const CALL_RING_TIMEOUT_SEC = 60;

/**
 * How long a room's binding to its group lives: the ring window plus the longest call. Past it the
 * room id names nothing and `room-token` answers 410.
 */
const CALL_ROOM_BINDING_TTL_SEC = CALL_RING_TIMEOUT_SEC + MAX_CALL_SEC;

function userCallPresenceKey(userId: string): string {
  return `call:user_active:${userId}`;
}

function callRoomKey(roomId: string): string {
  return `call:room:${roomId}`;
}

function callAnswerByKey(roomId: string): string {
  return `call:room:${roomId}:answer_by`;
}

/**
 * Written by `ring-end` for a room it names: the ring is over (answered, cancelled, ended). Read
 * before every APNs VoIP push, because Apple requires each one to raise a CallKit call - a push for
 * a call already over would flash a ring for nothing. Its TTL is the ring window: past it, the
 * answer deadline alone already refuses the push.
 */
function callRingEndedKey(roomId: string): string {
  return `call:room:${roomId}:ring_ended`;
}

/** What `prepareRing` hands the background fan-out. */
interface RingPlan {
  callerId: string;
  groupId: string;
  callId: string;
  hasVideo: boolean;
  calleeIds: string[];
}

@Injectable()
export class CallsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CallsService.name);
  private turnMeterReportInterval: ReturnType<typeof setInterval> | null = null;
  private turnMeterFirstReport: ReturnType<typeof setTimeout> | null = null;

  constructor(
    @InjectRepository(GroupMember)
    private readonly groupMemberRepo: Repository<GroupMember>,
    @InjectRepository(PushToken)
    private readonly pushTokenRepo: Repository<PushToken>,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly apnsVoip: ApnsVoipService,
    private readonly turnMeter: TurnUsageMeter
  ) {}

  /**
   * THE TURN METER HAS A REPORT, not only per-call error lines. A missing, revoked or mis-scoped
   * analytics token withholds TURN from EVERY call, indefinitely, and the per-call lines appear
   * only when someone calls - so the state is said once an hour, by the same family of hourly
   * reports as the rest of this service (see AppController), and at ERROR when calls are open and
   * the relay is withheld. While calls are `off` it asks nothing and says nothing: the meter is
   * then nobody's concern, and an hourly error about it would be noise.
   *
   * The reading is also what STORES each closed day's total (`TurnUsageMeter`), so a day is kept
   * even when nobody needed a relay that day.
   */
  onModuleInit(): void {
    this.turnMeterFirstReport = setTimeout(() => {
      void this.reportTurnMeter().catch((e) =>
        this.logger.error('[CRON] reportTurnMeter failed', e)
      );
    }, TURN_METER_FIRST_REPORT_MS);
    this.turnMeterReportInterval = setInterval(() => {
      void this.reportTurnMeter().catch((e) =>
        this.logger.error('[CRON] reportTurnMeter failed', e)
      );
    }, TURN_METER_REPORT_MS);
  }

  onModuleDestroy(): void {
    if (this.turnMeterFirstReport) clearTimeout(this.turnMeterFirstReport);
    if (this.turnMeterReportInterval) clearInterval(this.turnMeterReportInterval);
  }

  /** One line on the TURN meter's state. Public so the spec can run one report. */
  async reportTurnMeter(now: Date = new Date()): Promise<void> {
    const mode = await readCallsMode(this.groupMemberRepo.manager, this.logger);
    if (mode === 'off') {
      this.logger.debug('[TURN-METER] calls are off - the meter is not read');
      return;
    }
    const budget = this.turnBudget();
    if (budget.source === 'invalid') {
      this.logger.error(
        `[TURN-METER] CLOUDFLARE_TURN_MONTHLY_BUDGET_GB="${budget.raw}" is not a whole number of GB - read as 0, TURN is withheld from every call`
      );
      return;
    }
    if (budget.gb === 0) {
      this.logger.log(
        `[TURN-METER] the budget is 0 GB (calls_mode=${mode}) - calls are STUN only by configuration, the meter is not read`
      );
      return;
    }
    const budgetGb = budget.gb;
    let usedBytes: number;
    try {
      usedBytes = await this.turnMeter.monthEgressBytes(now);
    } catch (e) {
      if (!(e instanceof TurnMeterUnavailableError)) throw e;
      this.logger.error(
        `[TURN-METER] calls are open (calls_mode=${mode}) and the meter is UNAVAILABLE: ${e.reason} - TURN is withheld from every call until it reads`
      );
      return;
    }
    const usedGb = usedBytes / 1e9;
    const line = `[TURN-METER] ${now.toISOString().slice(0, 7)} (UTC calendar month): ${usedGb.toFixed(2)}/${budgetGb} GB metered egress (${((usedGb / budgetGb) * 100).toFixed(1)}%)`;
    if (usedBytes >= budgetGb * 1e9) {
      this.logger.error(`${line} - BUDGET REACHED, TURN is withheld from every call`);
    } else {
      this.logger.log(`${line} - TURN available`);
    }
  }

  /**
   * THE SERVER'S KILL SWITCH, asked on every request that STARTS or JOINS a call (B12): `initiate`,
   * `ring`, `room-token` and `ice-servers`. Not on `ring-end` or `presence`, which stop or record a
   * call and must keep working while one winds down. Read from the database each time, so a staff
   * member closing calls at `/admin/platform` holds from the next request.
   *
   * What it cannot do: a call already connected is peer to peer, its media never touches this server,
   * so it runs to its end; the switch stops every NEW call, every callee still to answer, and every
   * new TURN credential. The answer is a coded 403 the client words itself (`CALLS_DISABLED`,
   * `CALLS_VIDEO_DISABLED`), never who or why.
   *
   * @param wantsVideo True only for a ring that asks for video - the one request that names it.
   */
  private async assertCallsOpen(scope: string, userId: string, wantsVideo = false): Promise<void> {
    const mode = await readCallsMode(this.groupMemberRepo.manager, this.logger);
    if (mode === 'off') {
      this.logger.log(`[call] ${scope} REFUSED user=${userId}: calls are closed (calls_mode=off)`);
      throw new ForbiddenException({
        code: RefusalCode.CALLS_DISABLED,
        message: 'Calls are not available on this server.',
      });
    }
    if (wantsVideo && mode !== 'audio_video') {
      this.logger.log(
        `[call] ${scope} REFUSED user=${userId}: video asked, calls_mode=${mode} allows audio only`
      );
      throw new ForbiddenException({
        code: RefusalCode.CALLS_VIDEO_DISABLED,
        message: 'Video calls are not available on this server.',
      });
    }
  }

  /**
   * Verifies group membership, generates a UUID room ID, and returns a signed
   * room access token (TTL 5 min). The token must be sent to call-service in the
   * `Join` message to prove the user is authorized for this room.
   *
   * The returned `roomId` is ALSO the `callId` the client uses for the ring fan-out and for
   * every `CallMsg` it sends. That identity is what lets this service's `[call] invite` line
   * and call-service's `[call] session ...` records be read as one story - nothing else joins
   * them, so it must not become two values.
   */
  async initiateCall(userId: string, groupId: string): Promise<InitiateCallResponse> {
    this.logger.debug(`[calls] initiateCall user=${userId} group=${groupId}`);
    await this.assertCallsOpen(`initiate group=${groupId}`, userId);

    await this.assertMembership(userId, groupId, 'calls');

    const others = await this.otherMemberIds(groupId, userId);
    await this.refuseIfBlocked(userId, others, `initiate group=${groupId}`);

    const roomSecret = process.env.CALL_ROOM_SECRET?.trim();
    if (!roomSecret) {
      this.logger.error('[calls] CALL_ROOM_SECRET is not set - cannot issue room tokens');
      throw new ServiceUnavailableException('Call room tokens are not configured on this server');
    }

    const roomId = crypto.randomUUID();
    const roomToken = jwt.sign({ room_id: roomId, sub: userId, group_id: groupId }, roomSecret, {
      expiresIn: '5m',
      algorithm: 'HS256',
    });

    // Written BEFORE the room id leaves this server, so no callee can ever ask about a room this
    // binding does not yet name.
    // The window is NOT opened here: see `callAnswerByKey` and `ringGroup`.
    await this.redis.set(
      callRoomKey(roomId),
      JSON.stringify({ groupId, callerId: userId } satisfies CallRoomBinding),
      'EX',
      CALL_ROOM_BINDING_TTL_SEC
    );

    // At `log` rather than `debug`: this is the invite half of the call record, and a record
    // that survives only while debug logging is on is a record that is not there when needed.
    this.logger.log(`[call] invite room=${roomId} user=${userId} group=${groupId}`);
    return { roomId, roomToken, ringTimeoutMs: CALL_RING_TIMEOUT_SEC * 1000 };
  }

  /**
   * Issues a room access token for an existing room ID (used by call recipients).
   *
   * Three refusals, each an answer: not a member (403); a room `initiate` never bound to THIS
   * group (403 - knowing a room id must not buy a token signed for another conversation); and a
   * room whose ring window closed, whose ring `ring-end` recorded as over, or whose binding
   * expired (410 - the caller has stopped ringing, so there is nobody to answer).
   */
  async requestRoomToken(
    userId: string,
    groupId: string,
    roomId: string
  ): Promise<{ roomToken: string }> {
    this.logger.debug(`[calls] requestRoomToken user=${userId} group=${groupId} room=${roomId}`);
    await this.assertCallsOpen(`join-token room=${roomId}`, userId);

    await this.assertMembership(userId, groupId, 'calls');

    const roomSecret = process.env.CALL_ROOM_SECRET?.trim();
    if (!roomSecret) {
      this.logger.error('[calls] CALL_ROOM_SECRET is not set - cannot issue room tokens');
      throw new ServiceUnavailableException('Call room tokens are not configured on this server');
    }

    const binding = await this.readRoomBinding(roomId);
    if (!binding) {
      this.logger.warn(`[call] join-token REFUSED room=${roomId} user=${userId}: no such room`);
      throw new GoneException('This call is over');
    }
    if (binding.groupId !== groupId) {
      this.logger.warn(
        `[call] join-token REFUSED room=${roomId} user=${userId}: asked for group=${groupId}, the room is bound to another`
      );
      throw new ForbiddenException('This call does not belong to this conversation');
    }
    // A block set WHILE the call rang: `initiate` refused every block that already stood, so this
    // is the only one left, and it is answered before a token lets the two be connected.
    await this.refuseIfBlocked(userId, [binding.callerId], `join-token room=${roomId}`);
    const answerByRaw = await this.redis.get(callAnswerByKey(roomId));
    const answerBy = answerByRaw === null ? null : Number(answerByRaw);
    if (answerBy === null || !Number.isFinite(answerBy)) {
      // The caller never reached `ring` (the client rings BEFORE its invite leaves, so no callee
      // can normally see this), or the value is not a number - a defect of this service.
      this.logger.warn(
        `[call] join-token REFUSED room=${roomId} user=${userId}: the ring window never opened (${answerByRaw ?? 'absent'})`
      );
      throw new GoneException('This call is over');
    }
    if (Date.now() > answerBy) {
      this.logger.log(
        `[call] join-token REFUSED room=${roomId} user=${userId}: the ring window closed`
      );
      throw new GoneException('This call is over');
    }
    // The ring ENDED inside its window: the caller cancelled, a device answered, or the call ended
    // (a decline included). Nobody is left to answer, so the window no longer counts. The device
    // that answers asks for its token BEFORE it calls `ring-end answered`, so its own answer never
    // meets this; a sibling of it asking afterwards does, and that call is taken.
    const ringEnded = await this.redis.get(callRingEndedKey(roomId));
    if (ringEnded !== null) {
      this.logger.log(
        `[call] join-token REFUSED room=${roomId} user=${userId}: the ring ended (${ringEnded})`
      );
      throw new GoneException('This call is over');
    }

    const roomToken = jwt.sign({ room_id: roomId, sub: userId, group_id: groupId }, roomSecret, {
      expiresIn: '5m',
      algorithm: 'HS256',
    });

    // The answer half: a callee asking for a token is a callee about to join the SFU. Paired
    // with the SFU's own record it separates "never answered" from "answered and never arrived".
    this.logger.log(`[call] join-token room=${roomId} user=${userId} group=${groupId}`);
    return { roomToken };
  }

  /**
   * Opens the room's ring window - ONCE, from the room's caller. `SET NX` is the whole of "once":
   * two concurrent rings cannot both write, and a retry cannot extend the window. The window key
   * expires with the binding (its remaining PTTL), never later. Throws the same answers as
   * `room-token` for a room that is not this caller's to ring.
   */
  private async openRingWindow(callerId: string, groupId: string, roomId: string): Promise<void> {
    const binding = await this.readRoomBinding(roomId);
    if (!binding) {
      this.logger.warn(`[ring] REFUSED call=${roomId} caller=${callerId}: no such room`);
      throw new GoneException('This call is over');
    }
    if (binding.groupId !== groupId || binding.callerId !== callerId) {
      this.logger.warn(
        `[ring] REFUSED call=${roomId} caller=${callerId} group=${groupId}: not this caller's room`
      );
      throw new ForbiddenException('This call does not belong to this caller');
    }
    const remainingMs = await this.redis.pttl(callRoomKey(roomId));
    if (remainingMs <= 0) {
      // Expired between the read and now (or has no TTL, which `initiate` never writes).
      this.logger.warn(
        `[ring] REFUSED call=${roomId} caller=${callerId}: the room expired (pttl=${remainingMs})`
      );
      throw new GoneException('This call is over');
    }
    const opened = await this.redis.set(
      callAnswerByKey(roomId),
      String(Date.now() + CALL_RING_TIMEOUT_SEC * 1000),
      'PX',
      remainingMs,
      'NX'
    );
    if (opened !== 'OK') {
      this.logger.warn(`[ring] call=${roomId} rung again - the first window stands`);
    }
  }

  /**
   * The binding `initiate` wrote for `roomId`, or `null` when there is none (expired or never) or
   * it is not a binding this version can trust. Validated, never cast: a value is evidence only of
   * the shape it was written in.
   */
  private async readRoomBinding(roomId: string): Promise<CallRoomBinding | null> {
    const raw = await this.redis.get(callRoomKey(roomId));
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Only `initiate` writes this key, so an unparseable value is a defect here, named as one.
      this.logger.error(`[call] room binding for ${roomId} is unreadable: ${String(e)}`);
      return null;
    }
    const value = parsed as Partial<CallRoomBinding> | null;
    if (typeof value?.groupId === 'string' && typeof value.callerId === 'string') {
      return { groupId: value.groupId, callerId: value.callerId };
    }
    if (typeof value?.groupId === 'string') {
      // The lot 1 shape (#1997, no `callerId`): a room opened by the build before this one. Nobody
      // may ring it, so it is refused like an expired room. The gap is ONE deploy wide and dev
      // only (calls are off in production), and closes on its own when those bindings expire.
      this.logger.warn(
        `[call] room binding for ${roomId} predates the ring window (no callerId) - refused`
      );
      return null;
    }
    this.logger.error(`[call] room binding for ${roomId} has no usable shape - refused`);
    return null;
  }

  /**
   * Returns ICE server configuration for an authenticated group member.
   * Requires a valid `callId` so credentials are scoped per call session. 503 when TURN is not
   * configured at all (a deployment defect); STUN only with a typed `turn.code` when the budget is
   * spent or its meter unreadable, so a call that needs no relay still connects.
   */
  async getIceServers(
    userId: string,
    groupId: string,
    callId: string
  ): Promise<IceServersResponse> {
    this.logger.debug(`[ICE] getIceServers user=${userId} group=${groupId} call=${callId}`);
    await this.assertCallsOpen(`ice-servers call=${callId}`, userId);

    await this.assertMembership(userId, groupId, 'ICE');

    // TURN OFF BY CONFIGURATION is decided BEFORE TURN's own configuration is checked: an estate set
    // to a budget of 0 needs no TURN secrets, and must answer STUN only rather than 503.
    const disabled = this.turnDisabled(callId);
    if (disabled) {
      return { iceServers: STUN_ONLY, turn: { status: 'unavailable', code: disabled } };
    }

    const cloudflareToken = process.env.CLOUDFLARE_CALLS_API_TOKEN?.trim();
    const turnKeyId = process.env.CLOUDFLARE_TURN_KEY_ID?.trim();

    if (!cloudflareToken || !turnKeyId) {
      this.logger.error(
        '[ICE] Cloudflare TURN is not configured (CLOUDFLARE_CALLS_API_TOKEN and CLOUDFLARE_TURN_KEY_ID required)'
      );
      throw new ServiceUnavailableException('WebRTC TURN is not configured on this server');
    }

    // No TURN credential is minted once the month's METERED relay egress reaches the budget, or
    // while the meter cannot be read: no relay without a budget behind it (`TurnUsageMeter`, B7).
    //
    // A TYPED DEGRADATION BY DESIGN, NOT A FALLBACK. Withholding TURN is the decision the budget
    // exists to make; refusing the whole request instead would also refuse every DIRECT call, which
    // costs nothing and was never what the budget protects. So the answer is STUN only plus the
    // typed reason (`turn.code`), logged at ERROR per call - the relay leg is gone and every call
    // that needed it will fail to connect, which someone must read.
    const withheld = await this.turnWithheld(callId);
    if (withheld) {
      return { iceServers: STUN_ONLY, turn: { status: 'unavailable', code: withheld } };
    }

    // One credential per request, never shared: a TURN credential is a member's for its TTL, and
    // handing one in flight to an unrelated member would put two people's relay on one username.
    const { iceServers } = await this.fetchCloudflareIceServers(turnKeyId, cloudflareToken);
    return { iceServers, turn: { status: 'available' } };
  }

  /** Why TURN must be withheld for this call, or null when a credential may be minted. */
  /**
   * `TURN_DISABLED` when the budget turns TURN off by configuration (0, or a value read as 0), else
   * null. The meter is not asked: nothing it could say would change the answer.
   */
  private turnDisabled(callId: string): 'TURN_DISABLED' | null {
    const budget = this.turnBudget();
    if (budget.source === 'invalid') {
      // A configuration nobody can read IS a fault: at error, every call, until someone fixes it.
      this.logger.error(
        `[ICE] call=${callId} TURN withheld (TURN_DISABLED): CLOUDFLARE_TURN_MONTHLY_BUDGET_GB="${budget.raw}" is not a whole number of GB - read as 0, STUN only`
      );
      return 'TURN_DISABLED';
    }
    if (budget.gb === 0) {
      // A DECISION, NOT A FAULT: the owner set the budget to 0 to keep calls STUN only. Said per call
      // at `log` (the call's own trail), never at error.
      this.logger.log(
        `[ICE] call=${callId} TURN withheld (TURN_DISABLED): the budget is 0 GB - STUN only by configuration`
      );
      return 'TURN_DISABLED';
    }
    return null;
  }

  private async turnWithheld(callId: string): Promise<TurnUnavailableCode | null> {
    const budget = this.turnBudget();
    let usedBytes: number;
    try {
      usedBytes = await this.turnMeter.monthEgressBytes();
    } catch (e) {
      if (!(e instanceof TurnMeterUnavailableError)) throw e;
      this.logger.error(
        `[ICE] call=${callId} TURN withheld (TURN_METER_UNAVAILABLE): ${e.reason} - STUN only, a call that needs a relay will not connect`
      );
      return 'TURN_METER_UNAVAILABLE';
    }
    if (usedBytes < budget.gb * 1e9) return null;
    this.logger.error(
      `[ICE] call=${callId} TURN withheld (TURN_BUDGET_REACHED): ${(usedBytes / 1e9).toFixed(1)}/${budget.gb} GB metered egress this month - STUN only`
    );
    return 'TURN_BUDGET_REACHED';
  }

  /**
   * Monthly TURN relay budget in decimal GB of metered egress (Cloudflare's free allowance is 1000 GB
   * per account; the default leaves a margin).
   */
  private turnBudget(): TurnBudget {
    return readTurnBudget(process.env.CLOUDFLARE_TURN_MONTHLY_BUDGET_GB);
  }

  /**
   * Records whether this device is currently in an active call (Redis, per user).
   * Used so sibling devices can warn the user on app open.
   */
  async reportCallPresence(
    userId: string,
    deviceId: string,
    body: { active: boolean; callId?: string; groupId?: string }
  ): Promise<{ ok: true }> {
    if (!deviceId?.trim()) {
      throw new BadRequestException('deviceId is required');
    }

    const key = userCallPresenceKey(userId);

    if (!body.active) {
      const raw = await this.redis.get(key);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as UserCallPresence;
          if (parsed.deviceId === deviceId) {
            await this.redis.del(key);
            this.logger.debug(`[calls] cleared presence for user=${userId} device=${deviceId}`);
          }
        } catch {
          await this.redis.del(key);
        }
      }
      return { ok: true };
    }

    const payload: UserCallPresence = {
      deviceId,
      callId: body.callId,
      groupId: body.groupId,
      updatedAt: Date.now(),
    };
    await this.redis.set(key, JSON.stringify(payload), 'EX', USER_CALL_PRESENCE_TTL_SEC);
    this.logger.debug(
      `[calls] presence active user=${userId} device=${deviceId} call=${body.callId ?? '?'}`
    );
    return { ok: true };
  }

  /**
   * Returns whether another device of the same user is currently in a call.
   */
  async getSiblingCallStatus(userId: string, deviceId: string): Promise<SiblingCallStatusResponse> {
    if (!deviceId?.trim()) {
      throw new BadRequestException('deviceId is required');
    }

    const raw = await this.redis.get(userCallPresenceKey(userId));
    if (!raw) return { active: false };

    try {
      const parsed = JSON.parse(raw) as UserCallPresence;
      if (!parsed.deviceId || parsed.deviceId === deviceId) {
        return { active: false };
      }
      return {
        active: true,
        deviceId: parsed.deviceId,
        callId: parsed.callId,
        groupId: parsed.groupId,
      };
    } catch {
      return { active: false };
    }
  }

  /** Calls Cloudflare Realtime TURN API to generate short-lived credentials. */
  private async fetchCloudflareIceServers(
    turnKeyId: string,
    apiToken: string
  ): Promise<{ iceServers: IceServerConfig[] }> {
    const ttl = parseInt(process.env.CLOUDFLARE_TURN_TTL_SECONDS || '7200', 10);
    const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${turnKeyId}/credentials/generate-ice-servers`;

    this.logger.debug(`[ICE] Requesting Cloudflare TURN credentials (ttl=${ttl})`);

    let data: { iceServers?: IceServerConfig[] };
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl }),
        // Bounded like the meter's: a Cloudflare that never answers must not hold every call
        // setup open. The signal covers the body read as well.
        signal: AbortSignal.timeout(METER_TIMEOUT_MS),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        this.logger.error(
          `[ICE] Cloudflare TURN API error status=${response.status} body=${body.slice(0, 200)}`
        );
        throw new ServiceUnavailableException('Failed to generate TURN credentials');
      }
      data = (await response.json()) as { iceServers?: IceServerConfig[] };
    } catch (e) {
      if (e instanceof ServiceUnavailableException) throw e;
      const timedOut = e instanceof Error && e.name === 'TimeoutError';
      this.logger.error(
        `[ICE] Cloudflare TURN API ${timedOut ? `gave no answer within ${METER_TIMEOUT_MS} ms` : `unreachable: ${String(e)}`}`
      );
      throw new ServiceUnavailableException('Failed to generate TURN credentials');
    }
    const iceServers = this.filterIceServers(data.iceServers ?? []);

    if (iceServers.length === 0) {
      this.logger.error('[ICE] Cloudflare returned no usable ICE servers');
      throw new ServiceUnavailableException('No ICE servers available');
    }

    this.logger.debug(`[ICE] Cloudflare returned ${iceServers.length} ICE server(s)`);
    return { iceServers };
  }

  // --- Incoming-call ring fan-out (WP-XP-5 priority notifications) ----------
  //
  // The server cannot read MLS ciphertexts, so it cannot tell a call invite from a
  // regular message. The CALLER's client therefore triggers the ring explicitly with a
  // minimal cleartext payload of IDS ONLY (callId/groupId/callerId/hasVideo - never a name,
  // decision 6: each phone names the caller from its own copy). The MLS
  // CallMsg protos themselves are sent silent; visible ringing on killed devices comes
  // exclusively from this fan-out.

  /**
   * Rings every OTHER member of the group about an incoming call:
   *  - Android tokens -> high-priority FCM data push `type=call_ring` (native CallStyle
   *    notification, instant - no MLS decrypt on the ring path).
   *  - iOS tokens WITH a voipToken -> direct APNs VoIP push (CallKit full-screen ring), ids only,
   *    and only while the ring is live (`liveRingDeadline`).
   *  - iOS tokens WITHOUT a voipToken (pre-WP-XP-5 builds) -> regular FCM alert push so
   *    the callee at least sees a banner.
   * Best-effort per device; failures never abort the fan-out.
   */
  async ringGroup(
    callerId: string,
    groupId: string,
    callId: string,
    hasVideo: boolean
  ): Promise<void> {
    const plan = await this.prepareRing(callerId, groupId, callId, hasVideo);
    if (!plan) return;
    // The caller is answered BEFORE the fan-out, and with a body that says nothing about it: how
    // long the pushes take, and how many went out, would otherwise tell the caller whether a callee
    // refused calls (the refused path skips every push). A failure is logged, never thrown at a
    // caller who has already been answered.
    void this.fanOutRing(plan).catch((e: unknown) =>
      this.logger.error(`[ring] call=${callId} group=${groupId} fan-out failed`, e as Error)
    );
  }

  /**
   * The part of a ring the caller must wait for: it may refuse (not a member, a block), and it
   * opens the answer window. Resolves null when there is nobody to ring.
   */
  private async prepareRing(
    callerId: string,
    groupId: string,
    callId: string,
    hasVideo: boolean
  ): Promise<RingPlan | null> {
    this.logger.debug(`[ring] ringGroup caller=${callerId} group=${groupId} call=${callId}`);
    await this.assertCallsOpen(`ring call=${callId}`, callerId, hasVideo);
    await this.assertMembership(callerId, groupId, 'ring');
    const calleeIds = await this.otherMemberIds(groupId, callerId);
    // Re-checked here and not only at `initiate`: between the two the caller's client waits on the
    // first microphone prompt with no limit, so a block set meanwhile must still stop the ring. A
    // refused ring already ends the call on the client. Before the window opens, so a refused call
    // leaves no answer window behind.
    await this.refuseIfBlocked(callerId, calleeIds, `ring call=${callId}`);
    // BEFORE the fan-out: the window must not depend on how long FCM and APNs take to answer.
    await this.openRingWindow(callerId, groupId, callId);

    if (calleeIds.length === 0) {
      this.logger.warn(`[ring] call=${callId} group=${groupId} has no other member to ring`);
      return null;
    }
    return { callerId, groupId, callId, hasVideo, calleeIds };
  }

  /** The push fan-out of a ring; resolves with how many devices were handed the ring. */
  private async fanOutRing(plan: RingPlan): Promise<{ rang: number }> {
    const { callerId, groupId, callId, hasVideo, calleeIds } = plan;
    const ringable = await this.membersWhoTakeCalls(groupId, callId, calleeIds);
    if (ringable.length === 0) {
      this.logger.log(`[ring] call=${callId} group=${groupId} rang=0 - nobody may be rung`);
      return { rang: 0 };
    }

    const tokens = await this.pushTokenRepo.find({ where: { userId: In(ringable) } });
    // Checked once per fan-out rather than once per device: without Firebase every FCM ring is
    // skipped, and `rang=0/N` on its own reads as "nobody was reachable" when the truth is that
    // this server never asked anyone. iOS VoIP goes straight to APNs and is unaffected.
    const fcmReady = this.firebaseReady('ring');
    // A device holds a voipToken only when its binary carries the native ring (the TS bridge sends
    // one under CALLS_NATIVE_RING_COMPILED and clears it otherwise): that token IS the device's
    // statement that it reports every VoIP push to CallKit. Without the APNs key such a device is
    // not rung at all - an FCM alert in its place would be a second path hiding the missing key.
    const voipReady =
      tokens.some((pt) => pt.platform === 'ios' && pt.voipToken) && this.apnsVoipReady();

    // IDS ONLY, ON EVERY PLATFORM (decision 6; WP-C5 with the native ring, 2026-10-30): the payload
    // is cleartext to FCM and to APNs, and both rings name the caller from the PHONE'S own copy of
    // names. The names this used to carry are gone, not moved.
    const dataFields: Record<string, string> = {
      type: 'call_ring',
      groupId,
      callId,
      callerId,
      hasVideo: hasVideo ? 'true' : 'false',
    };

    let rang = 0;
    for (const pt of tokens) {
      const delivered =
        pt.platform === 'ios' && pt.voipToken
          ? voipReady && (await this.ringIosVoip(pt, { groupId, callId, callerId }))
          : fcmReady && (await this.ringViaFcm(pt, dataFields));
      if (delivered) rang++;
    }
    this.logger.log(`[ring] call=${callId} group=${groupId} rang=${rang}/${tokens.length} devices`);
    return { rang };
  }

  /**
   * Stops the ring on every member device (caller cancelled, someone answered, or the
   * call ended). Sent to ALL members including the sender's own user so sibling devices
   * stop ringing too; the device that is already in the call ignores its own callId.
   */
  async endRing(
    userId: string,
    groupId: string,
    callId: string,
    reason: 'cancelled' | 'answered' | 'ended'
  ): Promise<{ notified: number }> {
    this.logger.debug(
      `[ring] endRing user=${userId} group=${groupId} call=${callId} reason=${reason}`
    );
    await this.assertMembership(userId, groupId, 'ring-end');
    // The mark spares a late VoIP push; the ring-end pushes below stop rings ALREADY showing, so a
    // Redis failure here is logged and never keeps them from leaving.
    await this.markRingEnded(groupId, callId, reason).catch((e: unknown) =>
      this.logger.error(`[ring-end] call=${callId} could not be marked ended`, e as Error)
    );

    const members = await this.groupMemberRepo.find({
      where: { groupId, ...ADMITTED_SEAT },
      select: { userId: true },
    });
    const memberIds = [...new Set(members.map((m) => m.userId))];
    if (memberIds.length === 0) return { notified: 0 };
    // Before the loop, not inside it: the guard used to `break` mid-fan-out, which stopped the
    // remaining devices AND reported a count that looked like a partial delivery.
    if (!this.firebaseReady('ring-end')) return { notified: 0 };
    const tokens = await this.pushTokenRepo.find({ where: { userId: In(memberIds) } });

    const dataFields: Record<string, string> = {
      type: 'call_ring_end',
      groupId,
      callId,
      reason,
    };

    let notified = 0;
    for (const pt of tokens) {
      // Ring-end is a pure state signal: background/data push on both platforms. An iOS
      // device ringing via CallKit was just launched by the VoIP push, so its running
      // process receives this and reports the call ended; a missed delivery is covered
      // by the local 60s ring timeout on every platform.
      try {
        await getMessaging().send({
          token: pt.token,
          data: dataFields,
          android: { priority: 'high', ttl: 60_000 },
          apns: {
            payload: { aps: { 'content-available': 1 }, ...dataFields },
            headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
          },
        });
        notified++;
      } catch (e) {
        await this.dropTokenIfGone(pt, e, 'ring-end');
      }
    }
    this.logger.log(`[ring] ring-end call=${callId} notified=${notified}/${tokens.length}`);
    return { notified };
  }

  /**
   * Whether Firebase Admin is initialised, named when it is not. Every FCM ring depends on it,
   * so its absence is the single cause that reaches nobody at all - and it is invisible in the
   * `rang=N/M` summary, which counts devices rather than reasons.
   */
  private firebaseReady(scope: string): boolean {
    if (getApps().length > 0) return true;
    this.logger.error(`[${scope}] Firebase Admin is not initialised - no device can be reached`);
    return false;
  }

  /**
   * Every OTHER user holding an ADMITTED membership row in `groupId` (rows are per device, so
   * deduped): a seat awaiting a member's admission is rung by nobody ({@link ADMITTED_SEAT}).
   */
  private async otherMemberIds(groupId: string, userId: string): Promise<string[]> {
    const members = await this.groupMemberRepo.find({
      where: { groupId, ...ADMITTED_SEAT },
      select: { userId: true },
    });
    return [...new Set(members.map((m) => m.userId))].filter((id) => id !== userId);
  }

  /**
   * A CALL IS NEVER PLACED ACROSS A BLOCK, in either direction (WP-C7, the guideline 1.2 shot of the
   * App Review video: calling somebody who blocked you must not ring). A block leaves an existing
   * conversation readable (`docs/wiki/moderation-and-blocking.md`), but a ring is a new intrusion
   * on a person who asked for none, so it is refused here - where every call starts - rather than
   * filtered at the fan-out: refused at `initiate`, the caller never sends the MLS invite either,
   * so no device rings, in-app or native. The answer is the same `USER_BLOCKED` code the other
   * block refusals carry, and the same neutral sentence: never who blocked whom.
   *
   * Calls are 1:1 today, so ANY block between the two members refuses. A group call (WP-C11) must
   * decide whether one block refuses the call or only drops that member.
   */
  private async refuseIfBlocked(userId: string, others: string[], scope: string): Promise<void> {
    for (const other of others) {
      if (await isBlockedBetween(this.groupMemberRepo.manager, userId, other)) {
        this.logger.log(`[call] ${scope} REFUSED user=${userId}: a block stands between the two`);
        throw new ForbiddenException({
          code: RefusalCode.USER_BLOCKED,
          message: 'This call cannot be placed.',
        });
      }
    }
  }

  /**
   * The callees this conversation may RING - admitted members only ({@link ADMITTED_SEAT}) - and
   * among them each member's call permission (`callsAllowed`, resolved
   * against `notifLevel` by {@link callsAllowedFor}). A member who refused calls here is not pushed
   * at all - no CallStyle, no CallKit, whatever build the phone runs - and the caller is not told
   * why (the call simply goes unanswered, like any other). Read with the ring, never cached, so a
   * choice made a second ago already holds. A read that fails throws: the ring request fails and
   * the caller's call ends as `call_setup_failed`, rather than ringing somebody who may have said no.
   */
  private async membersWhoTakeCalls(
    groupId: string,
    callId: string,
    calleeIds: string[]
  ): Promise<string[]> {
    const rows = await this.groupMemberRepo.find({
      where: { groupId, userId: In(calleeIds), ...ADMITTED_SEAT },
      select: { userId: true, notifLevel: true, callsAllowed: true },
    });
    const withheld = new Set(
      rows.filter((r) => !callsAllowedFor(r.notifLevel, r.callsAllowed)).map((r) => r.userId)
    );
    if (withheld.size > 0) {
      this.logger.log(
        `[ring] call=${callId} group=${groupId} withheld from ${withheld.size} member(s) - calls not allowed in this conversation: ${[...withheld].map(cutUserId).join(',')}`
      );
    }
    // ONLY a callee whose ADMITTED seat was read: one with none - gone since the ring was planned,
    // or a seat still awaiting a member's admission - is rung by nobody, rather than passing for
    // want of a row to withhold it.
    const seated = new Set(rows.map((r) => r.userId));
    const unseated = calleeIds.filter((id) => !seated.has(id));
    if (unseated.length > 0) {
      this.logger.log(
        `[ring] call=${callId} group=${groupId} not rung: ${unseated.length} callee(s) hold no admitted seat: ${unseated.map(cutUserId).join(',')}`
      );
    }
    return calleeIds.filter((id) => seated.has(id) && !withheld.has(id));
  }

  /**
   * THE membership guard of every call route - initiate, the room token, the ICE servers and the
   * ring endpoints. A seat still awaiting a member's admission places, joins and rings nothing: it is
   * answered the 409 `awaiting_admission` ({@link callerSeatStanding}), never the 403 of no seat.
   */
  private async assertMembership(userId: string, groupId: string, scope: string): Promise<void> {
    const standing = await callerSeatStanding(this.groupMemberRepo, groupId, userId);
    if (standing === 'awaiting') {
      throw refuseAwaitingSeat(this.logger, scope, groupId, userId);
    }
    if (standing === null) {
      this.logger.warn(`[${scope}] user ${userId} is not a member of group ${groupId}`);
      throw new ForbiddenException('Not a member of this group');
    }
  }

  /**
   * Whether the APNs VoIP key is configured, named when it is not. Asked once per fan-out, and only
   * when a callee device holds a voipToken: a server without the key cannot ring a phone whose
   * binary carries the native ring, and `rang=N/M` alone would not say why.
   */
  private apnsVoipReady(): boolean {
    if (this.apnsVoip.isConfigured()) return true;
    this.logger.error(
      '[ring] a callee device holds a VoIP token and APNS_VOIP_* is not configured - it is not rung'
    );
    return false;
  }

  /**
   * Records that the ring of `callId` is over, for the VoIP fan-out to read. Written only for a room
   * bound to `groupId`: `ring-end` is gated on membership of the GROUP it names, so a member of
   * another conversation must not be able to silence this call's ring.
   */
  private async markRingEnded(groupId: string, callId: string, reason: string): Promise<void> {
    const binding = await this.readRoomBinding(callId);
    if (!binding || binding.groupId !== groupId) {
      this.logger.debug(`[ring-end] call=${callId} names no room of group=${groupId} - not marked`);
      return;
    }
    await this.redis.set(callRingEndedKey(callId), reason, 'EX', CALL_RING_TIMEOUT_SEC);
  }

  /**
   * The answer deadline (epoch ms) of a ring that is STILL LIVE, or null when a VoIP push must not
   * be sent: the ring ended (`ring-end` was called) or its answer window is closed. Apple requires
   * every VoIP push to raise a CallKit call, so a push for a call already over is a ring for
   * nothing. Read before each device, never once per fan-out: each APNs request can take seconds.
   */
  private async liveRingDeadline(callId: string): Promise<number | null> {
    const [answerByRaw, endedReason] = await Promise.all([
      this.redis.get(callAnswerByKey(callId)),
      this.redis.get(callRingEndedKey(callId)),
    ]);
    if (endedReason !== null) {
      this.logger.log(`[ring] call=${callId} VoIP push withheld - the ring ended (${endedReason})`);
      return null;
    }
    const answerBy = answerByRaw === null ? NaN : Number(answerByRaw);
    if (!Number.isFinite(answerBy)) {
      this.logger.warn(`[ring] call=${callId} VoIP push withheld - no answer window is open`);
      return null;
    }
    if (answerBy <= Date.now()) {
      this.logger.log(`[ring] call=${callId} VoIP push withheld - the answer window closed`);
      return null;
    }
    return answerBy;
  }

  /**
   * Direct APNs VoIP push -> CallKit ring, with a payload that names nobody (`voipRingPayload`).
   * Sent only while the ring is live; clears the voipToken on APNs 410.
   */
  private async ringIosVoip(
    pt: PushToken,
    ring: { groupId: string; callId: string; callerId: string }
  ): Promise<boolean> {
    const ringUntilMs = await this.liveRingDeadline(ring.callId);
    if (ringUntilMs === null) return false;
    const result = await this.apnsVoip.sendVoipPush(
      pt.voipToken as string,
      voipRingPayload({ ...ring, ringUntilMs }),
      Math.floor(ringUntilMs / 1000)
    );
    if (result === 'gone') {
      await this.pushTokenRepo.update({ id: pt.id }, { voipToken: null });
      this.logger.warn(`[ring] cleared expired voipToken user=${pt.userId} device=${pt.deviceId}`);
      return false;
    }
    return result;
  }

  /**
   * FCM ring delivery: Android gets the data payload (native CallStyle notification);
   * an iPhone with no voipToken gets a visible alert banner built by FCM's APNs relay.
   *
   * **That alert is GENERIC** (owner, 2026-10-22, calls.md B2'): until a native ring exists it is
   * titled "Canari" and reads "Appel entrant" / "Incoming call" in the device's language, with no
   * caller and no conversation name - neither in the alert nor in the payload keys, since FCM
   * merges `data` into the APNs payload too. Since 2026-10-30 no ring payload carries a name on any
   * platform (`fanOutRing`).
   */
  private async ringViaFcm(pt: PushToken, dataFields: Record<string, string>): Promise<boolean> {
    const toIos = pt.platform === 'ios';
    try {
      await getMessaging().send({
        token: pt.token,
        data: dataFields,
        android: { priority: 'high', ttl: 60_000 },
        apns: {
          payload: {
            aps: {
              alert: {
                title: 'Canari',
                body: incomingCallAlertBody(pt.locale),
              },
              sound: 'default',
              'mutable-content': 1,
            },
            ...dataFields,
          },
          headers: toIos
            ? {
                'apns-push-type': 'alert',
                'apns-priority': '10',
                // Bounds APNs store-and-forward like Android's 60 s ttl: a phone that was off must not
                // be handed a ring for a call long over. A DELIVERED banner is not touched by this -
                // call_ring_end and app activation remove it. The collapse id replaces a re-sent ring.
                'apns-expiration': String(Math.floor(Date.now() / 1000) + CALL_RING_TIMEOUT_SEC),
                // APNs refuses a collapse id over 64 bytes (a callId may be up to 128): none then.
                ...(Buffer.byteLength(dataFields.callId) <= 64
                  ? { 'apns-collapse-id': dataFields.callId }
                  : {}),
              }
            : { 'apns-push-type': 'alert', 'apns-priority': '10' },
        },
      });
      return true;
    } catch (e) {
      await this.dropTokenIfGone(pt, e, 'ring');
      return false;
    }
  }

  /** Deletes the push token row on terminal FCM errors (unregistered/invalid). */
  private async dropTokenIfGone(pt: PushToken, e: unknown, scope: string): Promise<void> {
    const msg = String(e);
    if (msg.includes('registration-token-not-registered') || msg.includes('invalid-argument')) {
      await this.pushTokenRepo.delete({ id: pt.id });
      this.logger.warn(
        `[${scope}] deleted invalid push token user=${pt.userId} device=${pt.deviceId}`
      );
    } else {
      this.logger.warn(`[${scope}] FCM failed user=${pt.userId} device=${pt.deviceId} err=${msg}`);
    }
  }

  /**
   * Filters out TURN URLs on port 53 (blocked by browsers per Cloudflare docs).
   */
  private filterIceServers(servers: IceServerConfig[]): IceServerConfig[] {
    return servers
      .map((server) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        const filtered = urls.filter((u) => !/:53(\?|$)/.test(u));
        if (filtered.length === 0) return null;
        return {
          ...server,
          urls: filtered.length === 1 ? filtered[0] : filtered,
        };
      })
      .filter((s): s is IceServerConfig => s !== null);
  }
}
