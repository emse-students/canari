import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { CallsService, callRoomKey } from './calls.service';
import { readCloudflareSfuApp, missingCloudflareSfuHalves } from '../utils/cloudflare-sfu-app';
import { RefusalCode } from '../utils/refusal-codes';
import { sanitizeQueryValue } from '../utils/sanitize';
import { METER_TIMEOUT_MS } from './turn-usage-meter.service';

/** Cloudflare Realtime's API root; every path below is under `apps/<appId>`. */
export const CLOUDFLARE_REALTIME_API = 'https://rtc.live.cloudflare.com/v1';

/** An SDP the client hands over or receives, carried verbatim: the proxy never reads media. */
export interface SessionDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

/** A track this user PUSHES from its own peer connection (`mid` of its transceiver). */
export interface LocalTrack {
  location: 'local';
  mid: string;
  trackName: string;
}

/** A track this user PULLS from another participant's session. */
export interface RemoteTrack {
  location: 'remote';
  sessionId: string;
  trackName: string;
}

/** The `tracks/new` request, as the client sends it and Cloudflare reads it. */
export interface TracksRequest {
  sessionDescription?: SessionDescription;
  tracks: (LocalTrack | RemoteTrack)[];
}

/** Cloudflare's answer to `tracks/new`, `renegotiate` and `tracks/close`, handed back verbatim. */
export interface RealtimeAnswer {
  sessionDescription?: SessionDescription;
  requiresImmediateRenegotiation?: boolean;
  tracks?: { mid?: string; trackName?: string; errorCode?: string; errorDescription?: string }[];
  errorCode?: string;
  errorDescription?: string;
}

/** One OTHER participant of the room, as `roster` lists them for the caller to pull from. */
export interface RosterEntry {
  userId: string;
  sessionId: string;
  /** The track names this participant pushed (a track Cloudflare refused is never listed). */
  tracks: string[];
}

/**
 * The seats of a Cloudflare-relayed room: `userId -> sessionId`. ONE seat per user (the group-call
 * rule of 2026-11-13: keys are per user, so two devices of one person cannot both send), so a
 * second device's session REPLACES the first.
 */
export function cloudflareSeatsKey(roomId: string): string {
  return `call:room:${roomId}:cf:seats`;
}

/** The track names one session pushed - what another participant may pull from it. */
export function cloudflareTracksKey(roomId: string, sessionId: string): string {
  return `call:room:${roomId}:cf:tracks:${sessionId}`;
}

/**
 * CLAIMS A SEAT, atomically: a user already seated replaces its session (one device per user); a
 * new user is refused once the room holds `cap` seats. Two joins racing for the last seat cannot
 * both pass, which a read-then-write would allow.
 *
 * KEYS[1] seats hash. ARGV: userId, sessionId, cap, ttl in ms (the room binding's remaining life).
 * Returns `{ seats after, previous session or '' }`, or `{ -1, '' }` when the room is full.
 */
export const CLAIM_SEAT_LUA = `
local previous = redis.call('HGET', KEYS[1], ARGV[1])
if not previous and redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then return {-1, ''} end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return {redis.call('HLEN', KEYS[1]), previous or ''}
`;

/**
 * RELEASES A SEAT only if it still holds THIS session: a replaced device's late `leave` must not
 * unseat the device that replaced it. Drops the session's track list with it.
 *
 * KEYS[1] seats hash, KEYS[2] the session's tracks set. ARGV: userId, sessionId.
 * Returns `{ 1 released | 0 not this session's seat, seats left }`.
 */
export const RELEASE_SEAT_LUA = `
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return {0, redis.call('HLEN', KEYS[1])} end
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
return {1, redis.call('HLEN', KEYS[1])}
`;

/** An SDP, bounded: Cloudflare's own are a few KB; 64 KB is far above any real one. */
function sessionDescriptionOf(value: unknown, field: string): SessionDescription {
  const sd = value as Partial<SessionDescription> | null;
  if (!sd || (sd.type !== 'offer' && sd.type !== 'answer')) {
    throw new BadRequestException(`${field}.type must be offer or answer`);
  }
  if (typeof sd.sdp !== 'string' || sd.sdp.length === 0 || sd.sdp.length > 64 * 1024) {
    throw new BadRequestException(`${field}.sdp must be a non-empty string of at most 64 KB`);
  }
  return { type: sd.type, sdp: sd.sdp };
}

/** At most this many tracks in one request: a participant pushes two and pulls two per other seat. */
const MAX_TRACKS_PER_REQUEST = 32;

/**
 * THE CLOUDFLARE REALTIME PROXY (WP-GC3): the sessions/tracks API of Cloudflare's SFU, behind the
 * app's own auth and the call gates, for a group call whose room `initiate` bound with
 * `mode: cloudflare` (`platform_config.call_relay = cloudflare`).
 *
 * WHY A PROXY. The app secret authorises every session of the app; a client holding it could open,
 * pull and close anyone's tracks. So it never leaves this service (`readCloudflareSfuApp`), and
 * each request is checked against what THIS server knows: the room token (first step), the room's
 * binding and the caller's membership (every step), and the seat ledger in Redis - a session is
 * driven only by the user who opened it, and a track is pulled only from a session seated in THE
 * SAME room. Media never crosses this service: only SDP, whose media is E2E-encrypted by the
 * clients' transforms before Cloudflare sees a frame (probe Q4, 2026-11-13).
 *
 * WHAT IT DOES NOT DO. It pushes nothing to the other participants: a client announces its session
 * over the conversation's own channel and the others pull it through `roster` and `tracks` (the
 * client half, WP-GC4). And it never falls back: an unconfigured app, a Cloudflare refusal or
 * silence is a typed `GROUP_CALL_RELAY_UNAVAILABLE`, never a mesh.
 */
@Injectable()
export class CloudflareSfuService {
  private readonly logger = new Logger(CloudflareSfuService.name);

  constructor(
    private readonly calls: CallsService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis
  ) {}

  /**
   * Opens this user's Cloudflare session for `roomId` and claims its seat. The room token is the
   * proof every call gate passed ({@link CallsService.admitToCloudflareRoom}); the seat claim is
   * atomic against the room's cap; a second device of the same user REPLACES the first's seat.
   *
   * @returns The new session id, and how many OTHER participants hold a seat (`0`: the room is
   *   empty - WP-GC6's fact, owed on the relay as on the mesh).
   */
  async openSession(
    userId: string,
    roomId: string,
    roomToken: string
  ): Promise<{ sessionId: string; others: number }> {
    this.logger.debug(`[sfu] openSession room=${roomId} user=${userId}`);
    const binding = await this.calls.admitToCloudflareRoom(userId, roomId, roomToken);
    const created = await this.realtime<{ sessionId?: unknown }>(
      'POST',
      '/sessions/new',
      undefined,
      `session room=${roomId} user=${userId}`
    );
    const sessionId = created.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      this.logger.error(`[sfu] session room=${roomId}: Cloudflare answered no session id`);
      throw this.upstreamRefusal();
    }
    const ttlMs = await this.roomTtlMs(roomId, userId);
    const [seats, previous] = (await this.redis.eval(
      CLAIM_SEAT_LUA,
      1,
      cloudflareSeatsKey(roomId),
      userId,
      sessionId,
      String(binding.maxSeats),
      String(ttlMs)
    )) as [number, string];
    if (seats < 0) {
      // The Cloudflare session just opened carries no track and no peer connection: it costs
      // nothing and closes itself; the refusal is the call's answer.
      this.logger.log(
        `[sfu] session room=${roomId} REFUSED user=${userId}: every seat is taken (cap=${binding.maxSeats})`
      );
      throw new ConflictException({
        code: RefusalCode.GROUP_CALL_ROOM_FULL,
        message: 'This group call is full.',
      });
    }
    if (previous) {
      this.logger.log(
        `[sfu] session room=${roomId} user=${userId}: replaces session ${previous} - one device per user, the earlier one is no longer seated`
      );
    }
    this.logger.log(
      `[sfu] session room=${roomId} user=${userId} session=${sessionId} seats=${seats}/${binding.maxSeats}`
    );
    return { sessionId, others: seats - 1 };
  }

  /**
   * Pushes this user's tracks and/or pulls other participants' (`tracks/new`). Every LOCAL track
   * is recorded under the session as pullable; every REMOTE one must name a session seated in this
   * room and a track that session pushed, and never the caller's own.
   */
  async addTracks(
    userId: string,
    roomId: string,
    sessionId: string,
    body: unknown
  ): Promise<RealtimeAnswer> {
    const scope = `tracks room=${roomId} user=${userId}`;
    await this.calls.assertCloudflareParticipant(userId, roomId, `sfu-${scope}`);
    await this.assertOwnSession(userId, roomId, sessionId, scope);
    const request = this.tracksRequestOf(body);
    const seats = await this.redis.hgetall(cloudflareSeatsKey(roomId));
    const seatedSessions = new Set(Object.values(seats));
    for (const track of request.tracks) {
      if (track.location !== 'remote') continue;
      if (track.sessionId === sessionId || !seatedSessions.has(track.sessionId)) {
        this.logger.warn(
          `[sfu] ${scope} REFUSED: pull from session ${track.sessionId}, which is not another seat of this room`
        );
        throw new ForbiddenException('That session is not a participant of this call');
      }
      const pushed = await this.redis.sismember(
        cloudflareTracksKey(roomId, track.sessionId),
        track.trackName
      );
      if (pushed !== 1) {
        this.logger.warn(
          `[sfu] ${scope} REFUSED: pull of track ${track.trackName}, which session ${track.sessionId} never pushed`
        );
        throw new ForbiddenException('That track is not published in this call');
      }
    }
    const answer = await this.realtime<RealtimeAnswer>(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/tracks/new`,
      request,
      scope
    );
    const refused = (answer.tracks ?? []).filter((t) => t.errorCode);
    for (const t of refused) {
      // A per-track refusal is Cloudflare's answer for that track only; the client reads it from
      // the answer it is handed. Logged, because nothing else would say a track never flowed.
      this.logger.warn(
        `[sfu] ${scope} Cloudflare refused track ${t.trackName ?? t.mid ?? '?'}: ${t.errorCode}`
      );
    }
    const refusedNames = new Set(refused.map((t) => t.trackName));
    const pushed = request.tracks
      .filter((t): t is LocalTrack => t.location === 'local')
      .map((t) => t.trackName)
      .filter((name) => !refusedNames.has(name));
    if (pushed.length > 0) {
      const key = cloudflareTracksKey(roomId, sessionId);
      await this.redis.sadd(key, ...pushed);
      await this.redis.pexpire(key, await this.roomTtlMs(roomId, userId));
    }
    const pulled = request.tracks.filter((t) => t.location === 'remote').length;
    this.logger.log(
      `[sfu] ${scope} session=${sessionId} pushed=${pushed.length} pulled=${pulled} refused=${refused.length}`
    );
    return answer;
  }

  /** Hands this user's renegotiation SDP to Cloudflare (`PUT renegotiate`), after a pull's offer. */
  async renegotiate(
    userId: string,
    roomId: string,
    sessionId: string,
    sessionDescription: unknown
  ): Promise<RealtimeAnswer> {
    const scope = `renegotiate room=${roomId} user=${userId}`;
    await this.calls.assertCloudflareParticipant(userId, roomId, `sfu-${scope}`);
    await this.assertOwnSession(userId, roomId, sessionId, scope);
    const description = sessionDescriptionOf(sessionDescription, 'sessionDescription');
    this.logger.debug(`[sfu] ${scope} session=${sessionId} type=${description.type}`);
    return this.realtime<RealtimeAnswer>(
      'PUT',
      `/sessions/${encodeURIComponent(sessionId)}/renegotiate`,
      { sessionDescription: description },
      scope
    );
  }

  /** Closes tracks of this user's own session (`PUT tracks/close`), by their `mid`. */
  async closeTracks(
    userId: string,
    roomId: string,
    sessionId: string,
    body: unknown
  ): Promise<RealtimeAnswer> {
    const scope = `close room=${roomId} user=${userId}`;
    await this.calls.assertCloudflareParticipant(userId, roomId, `sfu-${scope}`);
    await this.assertOwnSession(userId, roomId, sessionId, scope);
    const b = (body ?? {}) as { tracks?: unknown; sessionDescription?: unknown; force?: unknown };
    if (
      !Array.isArray(b.tracks) ||
      b.tracks.length === 0 ||
      b.tracks.length > MAX_TRACKS_PER_REQUEST
    ) {
      throw new BadRequestException(`tracks must list 1 to ${MAX_TRACKS_PER_REQUEST} mids`);
    }
    const tracks = b.tracks.map((t, i) => ({
      mid: sanitizeQueryValue((t as { mid?: unknown })?.mid, `tracks[${i}].mid`),
    }));
    const request: Record<string, unknown> = { tracks, force: b.force === true };
    if (b.sessionDescription !== undefined) {
      request.sessionDescription = sessionDescriptionOf(b.sessionDescription, 'sessionDescription');
    }
    this.logger.log(`[sfu] ${scope} session=${sessionId} closes ${tracks.length} track(s)`);
    return this.realtime<RealtimeAnswer>(
      'PUT',
      `/sessions/${encodeURIComponent(sessionId)}/tracks/close`,
      request,
      scope
    );
  }

  /**
   * The OTHER participants seated in this room and the tracks each pushed - what the caller may
   * pull. Only a seated participant may read it: the list names sessions, and a session id is what
   * a pull names.
   */
  async roster(
    userId: string,
    roomId: string
  ): Promise<{ participants: RosterEntry[]; others: number }> {
    const scope = `roster room=${roomId} user=${userId}`;
    await this.calls.assertCloudflareParticipant(userId, roomId, `sfu-${scope}`);
    const seats = await this.redis.hgetall(cloudflareSeatsKey(roomId));
    if (seats[userId] === undefined) {
      this.logger.warn(`[sfu] ${scope} REFUSED: the caller holds no seat in this room`);
      throw new ForbiddenException('Join the call before reading who is in it');
    }
    const participants: RosterEntry[] = [];
    for (const [other, sessionId] of Object.entries(seats)) {
      if (other === userId) continue;
      const tracks = await this.redis.smembers(cloudflareTracksKey(roomId, sessionId));
      participants.push({
        userId: other,
        sessionId,
        tracks: tracks.sort((x, y) => x.localeCompare(y)),
      });
    }
    participants.sort((a, b) => a.userId.localeCompare(b.userId));
    this.logger.debug(`[sfu] ${scope} others=${participants.length}`);
    return { participants, others: participants.length };
  }

  /**
   * Gives this user's seat back, only if it still holds `sessionId` (a replaced device's leave is a
   * no-op, said at log). Not gated on membership: a member removed mid-call must still be able to
   * leave. Cloudflare closes the session itself once its peer connection is gone.
   *
   * @returns How many participants are still seated - `0` is the empty room, which the caller's
   *   hangup states (`roomEmpty`, WP-GC6) exactly as on the mesh.
   */
  async leave(userId: string, roomId: string, sessionId: string): Promise<{ others: number }> {
    const [released, left] = (await this.redis.eval(
      RELEASE_SEAT_LUA,
      2,
      cloudflareSeatsKey(roomId),
      cloudflareTracksKey(roomId, sessionId),
      userId,
      sessionId
    )) as [number, number];
    if (released !== 1) {
      this.logger.log(
        `[sfu] leave room=${roomId} user=${userId} session=${sessionId}: not this user's seat (replaced or never seated) - nothing released`
      );
    } else {
      this.logger.log(
        `[sfu] leave room=${roomId} user=${userId} session=${sessionId} seats-left=${left}${left === 0 ? ' - the room is empty' : ''}`
      );
    }
    return { others: left };
  }

  /** The caller's seat must hold exactly `sessionId`: a session is driven only by its opener. */
  private async assertOwnSession(
    userId: string,
    roomId: string,
    sessionId: string,
    scope: string
  ): Promise<void> {
    const seated = await this.redis.hget(cloudflareSeatsKey(roomId), userId);
    if (seated !== sessionId) {
      this.logger.warn(
        `[sfu] ${scope} REFUSED: session ${sessionId} is not this user's seat (${seated === null ? 'no seat' : 'replaced by another device'})`
      );
      throw new ForbiddenException('This session is not yours');
    }
  }

  /** Validates a `tracks/new` body into exactly the fields Cloudflare reads - nothing else passes. */
  private tracksRequestOf(body: unknown): TracksRequest {
    const b = (body ?? {}) as { tracks?: unknown; sessionDescription?: unknown };
    if (
      !Array.isArray(b.tracks) ||
      b.tracks.length === 0 ||
      b.tracks.length > MAX_TRACKS_PER_REQUEST
    ) {
      throw new BadRequestException(`tracks must list 1 to ${MAX_TRACKS_PER_REQUEST} tracks`);
    }
    const tracks = b.tracks.map((raw, i): LocalTrack | RemoteTrack => {
      const t = (raw ?? {}) as Record<string, unknown>;
      // Names, mids and session ids are written into Redis and log lines: the generic allowlist.
      const trackName = sanitizeQueryValue(t.trackName, `tracks[${i}].trackName`);
      if (t.location === 'local') {
        return { location: 'local', mid: sanitizeQueryValue(t.mid, `tracks[${i}].mid`), trackName };
      }
      if (t.location === 'remote') {
        return {
          location: 'remote',
          sessionId: sanitizeQueryValue(t.sessionId, `tracks[${i}].sessionId`),
          trackName,
        };
      }
      throw new BadRequestException(`tracks[${i}].location must be local or remote`);
    });
    const request: TracksRequest = { tracks };
    if (b.sessionDescription !== undefined) {
      request.sessionDescription = sessionDescriptionOf(b.sessionDescription, 'sessionDescription');
    }
    if (tracks.some((t) => t.location === 'local') && !request.sessionDescription) {
      throw new BadRequestException('pushing a local track needs the offer that carries it');
    }
    return request;
  }

  /** The room binding's remaining life: every key of the relay dies with the room it serves. */
  private async roomTtlMs(roomId: string, userId: string): Promise<number> {
    const ttl = await this.redis.pttl(callRoomKey(roomId));
    if (ttl <= 0) {
      this.logger.warn(`[sfu] room=${roomId} user=${userId}: the room expired (pttl=${ttl})`);
      throw new GoneException('This call is over');
    }
    return ttl;
  }

  /** The typed answer for Cloudflare refusing or not answering: the relay, not the call, failed. */
  private upstreamRefusal(): BadGatewayException {
    return new BadGatewayException({
      code: RefusalCode.GROUP_CALL_RELAY_UNAVAILABLE,
      reason: 'upstream',
      message: 'The group call relay did not answer.',
    });
  }

  /**
   * ONE call to Cloudflare Realtime with the app's secret. A missing pair is a 503
   * (`unconfigured`); a non-2xx status, an `errorCode` in the body, an unreadable body or no answer
   * within the bound is a 502 (`upstream`) - each logged at ERROR with what Cloudflare said, and
   * never the secret.
   */
  private async realtime<T extends object>(
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
    scope: string
  ): Promise<T> {
    const app = readCloudflareSfuApp();
    if (!app) {
      this.logger.error(
        `[sfu] ${scope} REFUSED: the Cloudflare Realtime app is not configured (${missingCloudflareSfuHalves()} is not set)`
      );
      throw new ServiceUnavailableException({
        code: RefusalCode.GROUP_CALL_RELAY_UNAVAILABLE,
        reason: 'unconfigured',
        message: 'The group call relay is not available on this server.',
      });
    }
    const url = `${CLOUDFLARE_REALTIME_API}/apps/${encodeURIComponent(app.appId)}${path}`;
    let json: T & { errorCode?: string; errorDescription?: string };
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${app.appSecret}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Bounded like the TURN credential call: a Cloudflare that never answers must not hold a
        // call setup open. The signal covers the body read as well.
        signal: AbortSignal.timeout(METER_TIMEOUT_MS),
      });
      const text = await response.text();
      if (!response.ok) {
        this.logger.error(
          `[sfu] ${scope} Cloudflare ${method} ${path} answered ${response.status}: ${text.slice(0, 200)}`
        );
        throw this.upstreamRefusal();
      }
      json = JSON.parse(text) as typeof json;
    } catch (e) {
      if (e instanceof BadGatewayException) throw e;
      const timedOut = e instanceof Error && e.name === 'TimeoutError';
      this.logger.error(
        `[sfu] ${scope} Cloudflare ${method} ${path} ${timedOut ? `gave no answer within ${METER_TIMEOUT_MS} ms` : `failed: ${e instanceof Error ? e.message : String(e)}`}`
      );
      throw this.upstreamRefusal();
    }
    if (json?.errorCode) {
      this.logger.error(
        `[sfu] ${scope} Cloudflare ${method} ${path} refused: ${json.errorCode} ${json.errorDescription ?? ''}`
      );
      throw this.upstreamRefusal();
    }
    return json;
  }
}
