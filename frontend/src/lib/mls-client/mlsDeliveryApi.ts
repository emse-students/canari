import { assertOkMlsDeliveryResponse, deliveryKeepalivePost } from './mlsDeliveryHttp';
import { fetchJsonUnderProgressDeadline } from './progressDeadline';
import { ackMessagesWithRetry } from './ackRetry';
import { DELIVERY, type FrameDelivery } from './frameDelivery';
import type { GroupMeta, UserGroupRow } from './IMlsService';
import { toBase64, fromBase64 } from '$lib/utils/hex';

export type MlsDeliveryFetch = typeof fetch;

/**
 * Add-lock TTL (cross-device serialization of add commits). Sized on the real worst-case mobile
 * path: bulk add + state persist (~5-8 s) + validated commit + the Welcome loop, which easily
 * exceeds the original 10 s -> the lock expired mid-operation -> two devices committed in parallel
 * -> epoch fork on the successor (H1). [[H1]]
 */
export const MLS_ADD_LOCK_TTL_MS = 30_000;

/**
 * How long one pending page may stay COMPLETELY SILENT before it is abandoned.
 *
 * Not a budget for the page: {@link fetchJsonUnderProgressDeadline} re-arms it on the response head
 * and on every body chunk, so a slow transfer never trips it and the number does not have to cover
 * "the biggest page on the slowest link" - a product nobody can bound. What it has to exceed is the
 * longest stretch the design permits with nothing on the wire, and there is exactly one: the server
 * assembling a page, which it bounds at `PENDING_PAGE_MAX_BYTES` (1 MB) reading
 * `PENDING_FETCH_CHUNK_ROWS` (50) rows at a time. Ten seconds of total silence against that is
 * already pathological, which is the point - it is a hang-guard and nothing else decides how big a
 * page may be.
 */
export const PENDING_PAGE_STALL_MS = 10_000;

/**
 * The largest number of groups `POST /api/mls/history/batch` will accept in one request.
 *
 * This MIRRORS `HISTORY_BATCH_MAX_GROUPS` in chat-delivery-service's `messaging.service.ts`, whose
 * spec pins the value and names this constant: a client must not learn a limit by being refused,
 * and this one is not negotiated anywhere on the wire. Lowering the server's cap without lowering
 * this one puts every catch-up back to one request per conversation.
 */
export const HISTORY_BATCH_MAX_GROUPS = 50;

/**
 * The delivery service refused this device id: it was explicitly deleted, and the denylist is
 * permanent. Typed rather than message-matched, because the only cure is structural - enrol under
 * a fresh device id ({@link BaseMlsService.rotateDeviceIdentity}), never a retry of the same call.
 */
export class DeviceRevokedError extends Error {
  constructor(readonly deviceId: string) {
    super(`Device ${deviceId} is revoked server-side`);
    this.name = 'DeviceRevokedError';
  }
}

/**
 * The delivery service refused a read of a group's member list because this caller is not in it.
 *
 * `GET /api/mls/groups/:id/members` is members-only by design (audit S5: the device list leaks
 * social graph and device topology), so for the ONE case where the honest answer is "you are not a
 * member" the call is CERTAIN to be refused. That makes the 403 an ANSWER, not a failure - and the
 * distinction has to survive the throw, because the caller that asks this question retires a
 * conversation on "no" and must keep operating on "could not tell".
 *
 * Typed rather than message-matched, for the same reason as {@link DeviceRevokedError}: a
 * distinction carried in prose is one exactly one call site will make.
 */
export class NotAGroupMemberError extends Error {
  constructor(readonly groupId: string) {
    super(`Caller is not a member of group ${groupId}`);
    this.name = 'NotAGroupMemberError';
  }
}

export type MlsDeliveryApiOptions = {
  historyUrl: string;
  getToken: () => Promise<string>;
  /** Defaults to `globalThis.fetch` (browser); Tauri passes `plugin-http` fetch. */
  fetchImpl?: MlsDeliveryFetch;
};

/**
 * All HTTP traffic to chat-delivery (`/api/mls/*`) shared by Web (WASM) and Tauri (native MLS).
 * Platform services keep WebSocket + crypto; they delegate delivery REST here.
 */
export class MlsDeliveryApi {
  readonly historyUrl: string;
  userId = 'unknown';
  deviceId = 'pending';

  private readonly getToken: () => Promise<string>;
  private readonly f: MlsDeliveryFetch;

  constructor(opts: MlsDeliveryApiOptions) {
    this.historyUrl = opts.historyUrl;
    this.getToken = opts.getToken;
    this.f = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async auth(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await this.getToken();
    return { Authorization: `Bearer ${token}`, ...extra };
  }

  private uint8ToB64(bytes: Uint8Array): string {
    return toBase64(bytes);
  }

  /**
   * Fire-and-forget POST to the delivery service, resolving with the JSON body the server sent, or
   * `null` when it sent none (transport failure, non-2xx, non-JSON) - see `deliveryKeepalivePost`.
   */
  async deliveryPost(
    path: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown> | null> {
    return deliveryKeepalivePost(
      this.historyUrl,
      path,
      body,
      await this.auth({ 'Content-Type': 'application/json' })
    );
  }

  /** ACKs queue message ids with retry/backoff and sessionStorage persistence. */
  async ackMessages(messageIds: string[]): Promise<void> {
    await ackMessagesWithRetry(
      this.historyUrl,
      await this.auth({ 'Content-Type': 'application/json' }),
      { userId: this.userId, deviceId: this.deviceId, messageIds }
    );
  }

  /**
   * Raw JSON rows from `GET /api/mls/messages/:userId/:deviceId` (pending queue), page by page.
   *
   * The deadline is per PAGE and never spans the whole pull. A backlog is drained across as many
   * requests as it takes, so a budget covering all of them is a budget a device far enough behind
   * can never meet - and because nothing is ingested or ACKed until the pull returns, its queue then
   * only grows and it can never catch up (WP-PENDING-1, measured: 5 526 rows = 12 pages, aborted at
   * 10 s on every reconnect). Each page is therefore handed to `onPage` the moment it lands, so an
   * attempt that dies half-way still made progress the next one keeps.
   *
   * That per-page deadline measures SILENCE, not elapsed time ({@link PENDING_PAGE_STALL_MS}). The
   * deadline and the halving below are a detector and a response, not two answers to one question:
   * the deadline decides when to stop waiting, the ladder decides what to ask next, and neither can
   * do the other's job.
   */
  async pullPendingMessagesJson(opts?: {
    /** The longest SILENCE tolerated on one page. Defaults to {@link PENDING_PAGE_STALL_MS}. */
    stallTimeoutMs?: number;
    /** Receives each page as it lands; when set, pages are not accumulated in memory. */
    onPage?: (rows: unknown[]) => Promise<void> | void;
  }): Promise<unknown[]> {
    if (this.userId === 'unknown') return [];

    const stallTimeoutMs = opts?.stallTimeoutMs ?? PENDING_PAGE_STALL_MS;
    const all: unknown[] = [];
    let pageLimit = 500;
    let afterCreatedAt: string | undefined;

    while (true) {
      const url = new URL(`${this.historyUrl}/api/mls/messages/${this.userId}/${this.deviceId}`);
      url.searchParams.set('limit', String(pageLimit));
      if (afterCreatedAt) url.searchParams.set('after', afterCreatedAt);

      let batch: Array<{ createdAt?: string }>;
      try {
        const page = await fetchJsonUnderProgressDeadline<Array<{ createdAt?: string }>>(
          this.f,
          url.toString(),
          { headers: await this.auth() },
          stallTimeoutMs
        );
        if (!page.ok) break;
        batch = page.body;
      } catch (e) {
        // A page that does not arrive is a page ASKED FOR TOO BIG, until proven otherwise. Measured
        // on production: a device whose frames carried media needed 12 MB for 500 rows, timed out on
        // the deadline above having received nothing, ACKed nothing, and met the same 12 MB on every
        // later attempt - a closed loop, and the queue only grew. The server now bounds a page in
        // bytes, but the client must not depend on the server being new: halving is what makes an
        // OLD server survivable too, and what covers a link too slow for any fixed budget.
        //
        // Halving, never waiting: the retry changes the REQUEST, so it terminates on a proof - a
        // page of one row is the smallest question that can be asked, and failing that is a genuine
        // transport failure rather than an oversized answer. Nine steps at most, no clock anywhere.
        //
        // The reason travels with the error, so the line SEPARATES the two failures halving treats
        // alike: a server that never started answering (the size question) from a transfer that
        // started and stopped (the link). Nine identical "did not arrive" lines said neither.
        if (pageLimit > 1) {
          pageLimit = Math.max(1, Math.floor(pageLimit / 2));
          console.warn(
            `[PENDING] page did not arrive (${e instanceof Error ? e.message : String(e)}) - retrying with limit=${pageLimit}`
          );
          continue;
        }
        throw e;
      }
      if (!Array.isArray(batch) || batch.length === 0) break;

      if (opts?.onPage) await opts.onPage(batch);
      else all.push(...batch);

      // TERMINATION IS AN EMPTY PAGE, never a short one. A short page used to mean "the queue is
      // exhausted", which was an INFERENCE from the row limit being the only thing that bounded a
      // page - and it stopped being true the moment the server started capping a page in bytes.
      // Measured on production the day that shipped: the server capped a 500-row request at 53
      // rows / 1 039 524 bytes, the client read 53 < 500 as the end of the queue, and stopped with
      // 870 frames still waiting. It would have taken one reconnection per page. An empty page is
      // the only answer that PROVES there is nothing left, and it costs one extra request.

      const lastCreatedAt = batch[batch.length - 1]?.createdAt;
      if (!lastCreatedAt || lastCreatedAt === afterCreatedAt) break;
      afterCreatedAt = lastCreatedAt;
    }

    return all;
  }

  private decodeKeyPackageBase64(keyPackageB64: string): Uint8Array {
    return fromBase64(keyPackageB64);
  }

  /**
   * Asks the server whether this device is denylisted.
   *
   * Gates a destructive action on a server fact: the `device_revoked` control frame asks a device
   * to erase itself, and a frame is a message rather than an authority. Answers `false` when the
   * question cannot be reached - **a transport failure is not a verdict**, and erasing a device
   * because the network was down would be the worst possible reading of it.
   */
  async isDeviceRevoked(): Promise<boolean> {
    try {
      const res = await this.f(
        `${this.historyUrl}/api/mls/devices/${encodeURIComponent(this.userId)}/${encodeURIComponent(this.deviceId)}/revoked`,
        { headers: await this.auth() }
      );
      if (!res.ok) {
        console.warn(`[MLS] revocation check answered ${res.status} - treated as NOT revoked`);
        return false;
      }
      const d = (await res.json()) as { revoked?: boolean };
      return d.revoked === true;
    } catch (e) {
      console.warn('[MLS] revocation check unreachable - treated as NOT revoked:', e);
      return false;
    }
  }

  /**
   * Fetches a single device's consumable KeyPackage (no 30-day list cutoff).
   * Used when pending invitations reference a device not returned by {@link fetchUserDevices}.
   */
  async fetchDeviceKeyPackage(
    userId: string,
    deviceId: string
  ): Promise<{
    keyPackage: Uint8Array;
    deviceId: string;
    deviceName?: string;
    deviceOs?: string;
    deviceAppVersion?: string;
  } | null> {
    try {
      const res = await this.f(
        `${this.historyUrl}/api/mls/devices/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}/key-package`,
        { headers: await this.auth() }
      );
      if (!res.ok) return null;
      const d = await res.json();
      if (typeof d.keyPackage !== 'string' || typeof d.deviceId !== 'string') return null;
      return {
        keyPackage: this.decodeKeyPackageBase64(d.keyPackage),
        deviceId: d.deviceId,
        deviceName: typeof d.deviceName === 'string' ? d.deviceName : undefined,
        deviceOs: typeof d.deviceOs === 'string' ? d.deviceOs : undefined,
        deviceAppVersion: typeof d.deviceAppVersion === 'string' ? d.deviceAppVersion : undefined,
      };
    } catch (e) {
      console.error('Fetch device KeyPackage error:', e);
      return null;
    }
  }

  /**
   * Fetches KeyPackages for all active devices of `userId`.
   *
   * THROWS on transport/HTTP failure (network down, non-2xx): a `[]` must NEVER be
   * indistinguishable from a failure (see audit S2). Returns `[]` only for a genuine 200 with no
   * device. Best-effort callers (creation, KeyPackage fallback) opt in explicitly via
   * `.catch(() => [])`; the invitation path lets the error propagate so it never invites a
   * silent subset of members.
   */
  async fetchUserDevices(userId: string): Promise<
    Array<{
      keyPackage: Uint8Array;
      deviceId: string;
      deviceName?: string;
      deviceOs?: string;
      deviceAppVersion?: string;
    }>
  > {
    const res = await this.f(`${this.historyUrl}/api/mls/devices/${userId}`, {
      headers: await this.auth(),
    });
    if (!res.ok) throw new Error(`fetchUserDevices failed: ${res.status}`);
    // Raw device rows as returned by the server (untyped JSON). Optional metadata fields
    // are re-validated with `typeof` below before being kept.
    const devices = (await res.json()) as Array<{
      keyPackage: string;
      deviceId: string;
      deviceName?: string;
      deviceOs?: string;
      deviceAppVersion?: string;
    }>;

    return devices.map((d) => ({
      keyPackage: this.decodeKeyPackageBase64(d.keyPackage),
      deviceId: d.deviceId,
      deviceName: typeof d.deviceName === 'string' ? d.deviceName : undefined,
      deviceOs: typeof d.deviceOs === 'string' ? d.deviceOs : undefined,
      deviceAppVersion: typeof d.deviceAppVersion === 'string' ? d.deviceAppVersion : undefined,
    }));
  }

  /** Adds `userId` to the server-side member list of `groupId` (idempotent). */
  async registerMember(groupId: string, userId: string): Promise<void> {
    try {
      await this.f(`${this.historyUrl}/api/mls/groups/${groupId}/members`, {
        method: 'POST',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ userId }),
      });
    } catch (e) {
      console.error('Failed to register member', e);
    }
  }

  /** Registers this device on the delivery service with its initial KeyPackage and metadata. */
  async registerDeviceKeyPackage(params: {
    keyPackageBase64: string;
    deviceName?: string;
    deviceOs: string;
    deviceAppVersion?: string;
  }): Promise<void> {
    const response = await this.f(`${this.historyUrl}/api/mls/register-device`, {
      method: 'POST',
      headers: await this.auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        userId: this.userId,
        deviceId: this.deviceId,
        keyPackage: params.keyPackageBase64,
        ...(params.deviceName ? { deviceName: params.deviceName } : {}),
        deviceOs: params.deviceOs,
        ...(params.deviceAppVersion ? { deviceAppVersion: params.deviceAppVersion } : {}),
      }),
    });

    if (!response.ok) {
      // 403 + DEVICE_REVOKED is the one failure a retry can never fix: the id itself is banned.
      if (response.status === 403) {
        const code = await response
          .clone()
          .json()
          .then((b) => (b as { code?: string })?.code)
          .catch(() => undefined);
        if (code === 'DEVICE_REVOKED') throw new DeviceRevokedError(this.deviceId);
      }
      throw new Error(`Failed to publish KeyPackage: ${response.status} ${response.statusText}`);
    }
  }

  /** Uploads a batch of one-time prekeys (OTKP) to replenish the server-side prekey pool. */
  async publishKeyPackages(packages: Uint8Array[]): Promise<void> {
    const keyPackages = packages.map((bytes) => this.uint8ToB64(bytes));
    const response = await this.f(`${this.historyUrl}/api/mls/register-device/prekeys`, {
      method: 'POST',
      headers: await this.auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        userId: this.userId,
        deviceId: this.deviceId,
        keyPackages,
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed to publish key packages: ${response.status} ${response.statusText}`);
    }
  }

  /** Updates display metadata (name, OS, app version) for a device. */
  async updateDeviceMetadata(
    userId: string,
    deviceId: string,
    metadata: { deviceName?: string; deviceOs?: string; deviceAppVersion?: string }
  ): Promise<{
    status: string;
    deviceName: string | null;
    deviceOs: string | null;
    deviceAppVersion: string | null;
  }> {
    const response = await this.f(
      `${this.historyUrl}/api/mls/devices/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}/metadata`,
      {
        method: 'PATCH',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(metadata),
      }
    );
    if (!response.ok) {
      throw new Error(`Failed to update device metadata: ${response.status}`);
    }
    return await response.json();
  }

  /**
   * Delivers an MLS Welcome (and optional ratchet tree) to `targetUserId`.
   * If `targetDeviceId` is omitted, fans out to all active devices for that user.
   */
  async sendWelcome(
    welcomeBytes: Uint8Array,
    targetUserId: string,
    groupId: string,
    targetDeviceId?: string,
    ratchetTreeBytes?: Uint8Array,
    /** Tauri: when `targetDeviceId` is omitted, deliver only to the first online device (Web sends to all). */
    welcomeOpts?: { firstDeviceOnly?: boolean }
  ): Promise<void> {
    const base64 = this.uint8ToB64(welcomeBytes);
    const ratchetTreeBase64 = ratchetTreeBytes ? this.uint8ToB64(ratchetTreeBytes) : undefined;

    let deviceIds: string[];
    if (targetDeviceId) {
      deviceIds = [targetDeviceId];
    } else {
      const devices = await this.fetchUserDevices(targetUserId);
      deviceIds =
        welcomeOpts?.firstDeviceOnly && devices.length > 0
          ? [devices[0].deviceId]
          : devices.map((d) => d.deviceId);
    }
    if (deviceIds.length === 0) {
      throw new Error(`Cannot send secure invitation to ${targetUserId}: no active device found.`);
    }
    await Promise.all(
      deviceIds.map(async (deviceId) => {
        const response = await this.f(`${this.historyUrl}/api/mls/welcome`, {
          method: 'POST',
          headers: await this.auth({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            targetDeviceId: deviceId,
            targetUserId,
            senderUserId: this.userId,
            welcomePayload: base64,
            ratchetTreePayload: ratchetTreeBase64,
            groupId,
          }),
        });
        await assertOkMlsDeliveryResponse(
          response,
          `Welcome delivery to ${targetUserId}:${deviceId} (group ${groupId})`
        );
      })
    );
  }

  /**
   * Submits a staged MLS commit in one atomic server round-trip (`POST /api/mls/commit`): the
   * server validates the epoch (strict `baseEpoch == activeEpoch` under a Redis lock), and on
   * accept records it in the epoch-indexed commit-log (rung-1 replay backbone) AND fans it out to
   * members, skipping `excludeDeviceIds`. Returns the raw validation result so the caller merges
   * locally on accept / rolls back the staged commit on reject. Throws only on transport/HTTP
   * failure (not on a business reject). [[C7]]
   */
  async submitCommit(
    groupId: string,
    baseEpoch: number,
    protoBase64: string,
    excludeDeviceIds?: string[]
  ): Promise<{ accepted: boolean; reason?: string; currentEpoch?: number; newEpoch?: number }> {
    const res = await this.f(`${this.historyUrl}/api/mls/commit`, {
      method: 'POST',
      headers: await this.auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        groupId,
        deviceId: this.deviceId,
        baseEpoch,
        proto: protoBase64,
        senderId: this.userId,
        ...(excludeDeviceIds?.length ? { excludeDeviceIds } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`Commit submission HTTP error: ${res.status}`);
    }
    return res.json();
  }

  /**
   * Rung-1 replay: fetches the ordered commits the local client missed (`baseEpoch >= sinceEpoch`)
   * so it can apply them and catch up instead of dropping state (`GET /api/mls/commits/:groupId`).
   * `belowFloor` signals the intermediate commits were pruned, so the caller must fall back to
   * rung-2 (re-Welcome). `activeEpoch` is the epoch to reach after replay.
   */
  async fetchCommitsSince(
    groupId: string,
    sinceEpoch: number
  ): Promise<{
    commits: Array<{ baseEpoch: number; proto: string }>;
    activeEpoch: number;
    belowFloor: boolean;
  }> {
    const res = await this.f(
      `${this.historyUrl}/api/mls/commits/${encodeURIComponent(groupId)}?sinceEpoch=${sinceEpoch}`,
      { headers: await this.auth() }
    );
    if (!res.ok) {
      throw new Error(`Commit replay HTTP error: ${res.status}`);
    }
    return res.json();
  }

  /**
   * External-join base (Phase 4): fetches the latest stored GroupInfo for `groupId` so an authorized
   * member lacking MLS state can build an external commit to (re)join. Membership-gated server-side.
   * Returns null when no GroupInfo has been stored yet (caller falls back to a peer welcome_request).
   *
   * A 403 IS RAISED AS {@link NotAGroupMemberError}, for the reason it is on `getGroupMembers` next
   * door and with a sharper consequence. This endpoint is gated on a `dm_group_members` row, so the
   * status is the server answering the question the recovery seam is actually asking - and until it
   * was typed, that answer was flattened into `null` by the one caller and read as "nothing stored
   * yet", which is the state you retry. A group we had LEFT was therefore chased for as long as it
   * existed: one 403 and one broadcast asking to be re-added, every minute, terminating only if
   * somebody else happened to delete the group (GRP-6, 2026-08-24).
   *
   * Every other non-2xx stays unclassified, because none of them says anything about membership.
   */
  async fetchGroupInfo(groupId: string): Promise<{ groupInfo: string; baseEpoch: number } | null> {
    const res = await this.f(
      `${this.historyUrl}/api/mls/group-info/${encodeURIComponent(groupId)}`,
      { headers: await this.auth() }
    );
    if (res.status === 403) throw new NotAGroupMemberError(groupId);
    if (!res.ok) {
      throw new Error(`GroupInfo fetch HTTP error: ${res.status}`);
    }
    const data = await res.json();
    // The server returns null (no body content) when nothing is stored.
    return data && typeof data.groupInfo === 'string' ? data : null;
  }

  /**
   * Refreshes the stored GroupInfo for `groupId` (the committer calls this after each accepted commit;
   * a new group's first member-add is itself a commit). Membership-gated and monotonic server-side
   * (a lower baseEpoch is ignored).
   *
   * `stored: false` is the monotonic rule declining a base that is not newer, or an insert lost to
   * a concurrent first publish - both legitimate outcomes, neither a failure. A refresh may ignore
   * it; the caller initialising a group must not.
   */
  async storeGroupInfo(
    groupId: string,
    groupInfoBase64: string,
    baseEpoch: number
  ): Promise<{ stored: boolean }> {
    const res = await this.f(
      `${this.historyUrl}/api/mls/group-info/${encodeURIComponent(groupId)}`,
      {
        method: 'POST',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ groupInfo: groupInfoBase64, baseEpoch }),
      }
    );
    if (!res.ok) {
      throw new Error(`GroupInfo store HTTP error: ${res.status}`);
    }
    const data = await res.json().catch(() => null);
    return { stored: data?.stored === true };
  }

  /**
   * Acquires a distributed Redis lock to serialise concurrent `addMember` commits on `groupId`.
   * Returns `false` if another device already holds the lock (caller should abort or retry).
   */
  async acquireAddLock(groupId: string, ttlMs = MLS_ADD_LOCK_TTL_MS): Promise<boolean> {
    try {
      const res = await this.f(`${this.historyUrl}/api/mls/add-lock`, {
        method: 'POST',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ groupId, deviceId: this.deviceId, ttlMs }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      return data.acquired === true;
    } catch {
      // Fail-safe: cannot prove the lock was acquired → assume not acquired.
      // Returning true here would allow concurrent commits if Redis is temporarily
      // unavailable, which would fragment epochs and desync local WASM states.
      return false;
    }
  }

  /** Releases the add-lock previously acquired by {@link acquireAddLock}. Best-effort, non-throwing. */
  async releaseAddLock(groupId: string): Promise<void> {
    try {
      await this.f(`${this.historyUrl}/api/mls/add-lock`, {
        method: 'DELETE',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ groupId, deviceId: this.deviceId }),
      });
    } catch {
      /* non-blocking */
    }
  }

  /** Creates a new group row on the delivery service and returns the assigned `groupId`. */
  async createRemoteGroup(name: string, isGroup: boolean): Promise<string> {
    try {
      const res = await this.f(`${this.historyUrl}/api/mls/groups`, {
        method: 'POST',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          name,
          createdBy: this.userId,
          isGroup,
          creatorDeviceId: this.deviceId,
        }),
      });
      if (!res.ok) throw new Error('Failed to create remote group');
      const data = await res.json();
      return data.groupId as string;
    } catch (e) {
      console.error('Failed to create remote group', e);
      throw e;
    }
  }

  /** Returns the number of one-time prekeys still available for this device on the server. */
  async fetchPrekeyCount(): Promise<number> {
    try {
      const res = await this.f(
        `${this.historyUrl}/api/mls/devices/${this.userId}/${this.deviceId}/prekeys/count`,
        { headers: await this.auth() }
      );
      if (!res.ok) return 0;
      const data = await res.json();
      return typeof data.count === 'number' ? data.count : 0;
    } catch {
      return 0;
    }
  }

  /** Purges server-side one-time prekeys for this device (used on fresh WASM session). */
  async deleteAllOneTimePrekeys(): Promise<void> {
    await this.f(
      `${this.historyUrl}/api/mls/devices/${encodeURIComponent(this.userId)}/${encodeURIComponent(this.deviceId)}/prekeys`,
      { method: 'DELETE', headers: await this.auth() }
    ).catch(() => {});
  }

  /**
   * Lists the one-time prekeys published by this device (id + decoded payload) so the
   * client can locally validate which ones it still owns a private key for. Returns `[]` on error.
   */
  async listOwnPrekeys(): Promise<Array<{ id: string; keyPackage: Uint8Array }>> {
    try {
      const res = await this.f(
        `${this.historyUrl}/api/mls/devices/${encodeURIComponent(this.userId)}/${encodeURIComponent(this.deviceId)}/prekeys/list`,
        { headers: await this.auth() }
      );
      if (!res.ok) return [];
      const rows = await res.json();
      if (!Array.isArray(rows)) return [];
      return rows
        .filter((r) => typeof r?.id === 'string' && typeof r?.keyPackage === 'string')
        .map((r) => ({
          id: r.id as string,
          keyPackage: this.decodeKeyPackageBase64(r.keyPackage),
        }));
    } catch {
      return [];
    }
  }

  /** Deletes targeted one-time prekeys by id (orphaned from their local private key). */
  async pruneOwnPrekeys(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.f(
      `${this.historyUrl}/api/mls/devices/${encodeURIComponent(this.userId)}/${encodeURIComponent(this.deviceId)}/prekeys/prune`,
      {
        method: 'POST',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ids }),
      }
    ).catch(() => {});
  }

  /**
   * POSTs an already-encrypted MLS ciphertext to `/api/mls/send` without epoch validation. Used by
   * Tauri (native MLS handles epoch tracking internally).
   *
   * Both halves of `delivery` travel on the wire because the server holds ciphertext only and can
   * classify nothing itself: `silent` decides whether recipients are notified, `durable` whether
   * the frame is appended to the group's shared log.
   */
  async postApplicationMessage(
    groupId: string,
    protoBase64: string,
    delivery: FrameDelivery = DELIVERY.visible
  ): Promise<void> {
    const res = await this.f(`${this.historyUrl}/api/mls/send`, {
      method: 'POST',
      headers: await this.auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        senderId: this.userId,
        senderDeviceId: this.deviceId,
        groupId,
        proto: protoBase64,
        silent: delivery.silent,
        durable: delivery.durable,
      }),
    });
    if (!res.ok) {
      throw new Error(`Message send HTTP error: ${res.status}`);
    }
  }

  /**
   * Fetches one Redis Stream history page for a group, optionally paginated after `afterStreamId`.
   *
   * `until` is the INCLUSIVE upper bound for the walk - pass back the `head` the first page
   * returned, and the server never reads rows appended since (they belong to the delivery queue).
   * Returns an empty page on error.
   */
  async fetchHistory(
    groupId: string,
    afterStreamId?: string,
    limit?: number,
    until?: string
  ): Promise<import('$lib/mls-client/historyTypes').HistoryPage> {
    try {
      const url = new URL(`${this.historyUrl}/api/mls/history/${groupId}`);
      if (afterStreamId) url.searchParams.set('after', afterStreamId);
      if (until) url.searchParams.set('until', until);
      const effectiveLimit = limit !== undefined ? String(limit) : afterStreamId ? '200' : '1000';
      url.searchParams.set('limit', effectiveLimit);
      const res = await this.f(url.toString(), {
        headers: await this.auth(),
      });
      if (!res.ok) return { rows: [] };
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('application/json')) {
        console.warn(
          `[History] Non-JSON response for group ${groupId}. Received content-type: ${contentType || 'unknown'}`
        );
        return { rows: [] };
      }
      return { rows: await res.json(), head: res.headers.get('X-History-Head') ?? undefined };
    } catch (e) {
      console.error('Fetch History Error:', e);
      return { rows: [] };
    }
  }

  /**
   * Fetches the first history page for many groups, in as few round-trips as the server allows.
   *
   * The list is CHUNKED at {@link HISTORY_BATCH_MAX_GROUPS} because the server refuses anything
   * larger. It used to be sent whole, which meant a client with more conversations than the cap
   * sent one request that could only ever be refused - and the sequential re-fetch it then fell
   * back to made the catch-up cost exactly what it cost before the route existed. Measured on
   * production 2026-08-24: 110 conversations, one 400, 110 requests.
   *
   * A chunk the server refuses leaves its groups OUT of the map, and that is the whole handling.
   * There is no second way to fetch a page here: an absent group simply arrives at
   * `replayConversationHistory` unprimed and that replay reads its own first page, which is the
   * ordinary path every group took before any of this existed.
   */
  async fetchHistoryBatch(
    groups: Array<{ groupId: string; afterStreamId?: string }>
  ): Promise<Map<string, import('$lib/mls-client/historyTypes').HistoryPage>> {
    const out = new Map<string, import('$lib/mls-client/historyTypes').HistoryPage>();
    for (let i = 0; i < groups.length; i += HISTORY_BATCH_MAX_GROUPS) {
      await this.fetchHistoryBatchChunk(groups.slice(i, i + HISTORY_BATCH_MAX_GROUPS), out);
    }
    return out;
  }

  /**
   * One `POST /api/mls/history/batch`, writing what it gets into `out`.
   *
   * Never throws: a chunk that fails is a defect to READ, not a branch for the caller to take, so
   * it is logged with the status AND the server's own words - a status alone cannot tell a refused
   * request from an unreachable one, and it was a bare status that let the cap go unnoticed.
   */
  private async fetchHistoryBatchChunk(
    chunk: Array<{ groupId: string; afterStreamId?: string }>,
    out: Map<string, import('$lib/mls-client/historyTypes').HistoryPage>
  ): Promise<void> {
    try {
      const res = await this.f(`${this.historyUrl}/api/mls/history/batch`, {
        method: 'POST',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          groups: chunk.map((g) => ({
            groupId: g.groupId,
            after: g.afterStreamId,
          })),
        }),
      });
      const contentType = res.headers.get('content-type') ?? '';
      if (!res.ok || !contentType.toLowerCase().includes('application/json')) {
        console.error(
          `[History] batch of ${chunk.length} group(s) refused: ${res.status} ` +
            `content-type=${contentType || 'unknown'} body=${(await res.text()).slice(0, 200)}`
        );
        return;
      }
      const data = (await res.json()) as {
        histories?: Record<string, import('$lib/mls-client/historyTypes').HistoryStreamRow[]>;
        heads?: Record<string, string>;
      };
      for (const [groupId, rows] of Object.entries(data.histories ?? {})) {
        out.set(groupId, { rows: rows ?? [], head: data.heads?.[groupId] });
      }
    } catch (e) {
      console.error(`[History] batch of ${chunk.length} group(s) could not be sent:`, e);
    }
  }

  /** Renames a group on the server. Throws on non-2xx. */
  async renameGroup(groupId: string, name: string): Promise<void> {
    const res = await this.f(`${this.historyUrl}/api/mls/groups/${groupId}`, {
      method: 'PATCH',
      headers: await this.auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Rename failed: ${res.status}`);
  }

  /** Sets or clears (mediaId=null) the group's avatar on the server. Throws on non-2xx. */
  async setGroupImage(groupId: string, mediaId: string | null): Promise<void> {
    const res = await this.f(`${this.historyUrl}/api/mls/groups/${groupId}/image`, {
      method: 'PATCH',
      headers: await this.auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ mediaId }),
    });
    if (!res.ok) throw new Error(`setGroupImage failed: ${res.status}`);
  }

  /** Soft-deletes `groupId` on the server. Returns `false` if already absent (404). */
  async deleteGroupOnServer(groupId: string): Promise<boolean> {
    const res = await this.f(`${this.historyUrl}/api/mls/groups/${groupId}`, {
      method: 'DELETE',
      headers: await this.auth(),
    });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
    return true;
  }

  /** Removes `userId` from the server-side member list of `groupId`. */
  async removeMemberFromServer(groupId: string, userId: string): Promise<void> {
    const res = await this.f(`${this.historyUrl}/api/mls/groups/${groupId}/members/${userId}`, {
      method: 'DELETE',
      headers: await this.auth(),
    });
    if (!res.ok) throw new Error(`Remove member failed: ${res.status}`);
  }

  /**
   * Returns the current device-level member list (dm_device_group_memberships) for `groupId`.
   * THROWS on transport/HTTP failure: a `[]` must not mask a network failure (audit S2).
   * Returns `[]` only for a genuine 200 with no member. Tolerant callers opt in via `.catch`.
   *
   * A 403 is raised as {@link NotAGroupMemberError} and NOT as a generic failure: the endpoint is
   * members-only, so that status is the server stating the very fact the caller asked about. Every
   * other non-2xx stays unclassified, because none of them says anything about membership.
   */
  async getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]> {
    const res = await this.f(`${this.historyUrl}/api/mls/groups/${groupId}/members`, {
      headers: await this.auth(),
    });
    if (res.status === 403) throw new NotAGroupMemberError(groupId);
    if (!res.ok) throw new Error(`getGroupMembers failed: ${res.status}`);
    return await res.json();
  }

  /**
   * Returns user-level members from dm_group_members for `groupId`.
   * THROWS on transport/HTTP failure: a `[]` must not mask a network failure (audit S2).
   * Returns `[]` only for a genuine 200 with no member. Tolerant callers opt in via `.catch`.
   */
  async getGroupUserMembers(groupId: string): Promise<{ userId: string }[]> {
    const res = await this.f(`${this.historyUrl}/api/mls/groups/${groupId}/user-members`, {
      headers: await this.auth(),
    });
    if (!res.ok) throw new Error(`getGroupUserMembers failed: ${res.status}`);
    return await res.json();
  }

  /** Returns all groups `userId` belongs to, including soft-deleted tombstones (`deletedAt`). */
  async getUserGroups(userId: string): Promise<UserGroupRow[]> {
    const res = await this.f(`${this.historyUrl}/api/mls/users/${userId}/groups`, {
      headers: await this.auth(),
    });
    if (!res.ok) {
      throw new Error(`getUserGroups failed: ${res.status}`);
    }
    return await res.json();
  }

  /**
   * Server status of a group, distinguishing a CONFIRMED absence from network uncertainty -
   * something `getGroupMeta` (which returns `null` for both) cannot do. `GET /api/mls/groups/:id`
   * queries `dm_groups` WITHOUT a membership check and returns `null` (body) if the row does not
   * exist, hence:
   *  - `'absent'` : the server replied and the `dm_groups` row does not exist -> group really gone
   *    (never created / hard-purged). The only case where discovery may auto-delete the conversation.
   *  - `'error'`  : HTTP/network failure -> status unknown, delete NOTHING.
   *  - `GroupMeta`: the row exists (live group, `deletedAt` tombstone, or exclusion) -> keep the
   *    conversation locally (banner + manual deletion).
   */
  async getGroupServerStatus(groupId: string): Promise<'absent' | 'error' | GroupMeta> {
    let res: Response;
    try {
      res = await this.f(`${this.historyUrl}/api/mls/groups/${encodeURIComponent(groupId)}`, {
        headers: await this.auth(),
      });
    } catch {
      return 'error';
    }
    // 404 = no dm_groups row -> confirmed absent (never created or hard-purged).
    if (res.status === 404) return 'absent';
    // Other non-2xx (401/5xx/…) = real doubt -> never purge on error.
    if (!res.ok) return 'error';
    // The `GET mls/groups/:id` handler returns the group object, or `null` when not found.
    // NestJS serializes that `null` as an EMPTY body (200) -> `res.json()` would throw. An empty
    // or "null" 2xx body from THIS endpoint therefore unambiguously means "group absent" (not a
    // network error). This distinction lets discovery purge a deleted group instead of keeping
    // it indefinitely as "uncertain status". [[lifecycle]]
    const text = await res.text().catch(() => null);
    if (text === null) return 'error';
    const trimmed = text.trim();
    if (trimmed === '' || trimmed === 'null') return 'absent';
    let g: unknown;
    try {
      g = JSON.parse(trimmed);
    } catch {
      return 'absent';
    }
    if (!g || typeof g !== 'object') return 'absent';
    const id = (g as { id?: string; groupId?: string }).groupId ?? (g as { id?: string }).id;
    if (typeof id !== 'string' || !id) return 'absent';
    return {
      groupId: id,
      name:
        typeof (g as { name?: string }).name === 'string'
          ? (g as { name: string }).name
          : undefined,
      isGroup:
        typeof (g as { isGroup?: boolean }).isGroup === 'boolean'
          ? (g as { isGroup: boolean }).isGroup
          : undefined,
      deletedAt: (g as { deletedAt?: string | null }).deletedAt ?? null,
      // CARRIED, and they were not. `GroupMeta` has documented these as "the discriminator a
      // destructive sweep needs" since WP-22, `decideAbsentLocalGroupFate` reads them, and this
      // mapper dropped them on the floor - so the only thing that ever kept a distribution group
      // alive was having been registered earlier in the same session. A sweep that ran first
      // forgot it, and the seeds stopped arriving until the next boot re-registered it.
      distributionWorkspaceId:
        (g as { distributionWorkspaceId?: string | null }).distributionWorkspaceId ?? null,
      distributionChannelId:
        (g as { distributionChannelId?: string | null }).distributionChannelId ?? null,
    };
  }

  /**
   * Lists the groups THIS user deliberately dismissed (manual deletion/leave).
   * Discovery purges every local conversation present in this set - across all of the user's
   * devices. Returns `[]` on failure (never purge on a doubt).
   */
  async getDismissedGroups(): Promise<string[]> {
    try {
      const res = await this.f(
        `${this.historyUrl}/api/mls/users/${encodeURIComponent(this.userId)}/dismissed-groups`,
        { headers: await this.auth() }
      );
      if (!res.ok) return [];
      const arr = await res.json();
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * Marks a group as dismissed by this user - a manual delete or leave, propagated to their other
   * devices. Best-effort: the local purge has already happened, so a failure costs nothing here.
   */
  async dismissGroup(groupId: string): Promise<void> {
    try {
      await this.f(
        `${this.historyUrl}/api/mls/users/${encodeURIComponent(this.userId)}/dismissed-groups`,
        {
          method: 'POST',
          headers: await this.auth({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ groupId }),
        }
      );
    } catch {
      /* non-blocking: the local purge already happened and the other devices will retry */
    }
  }

  /** Lifts a group's dismiss (re-add via Welcome: the user wants the conversation back). Best-effort. */
  async undismissGroup(groupId: string): Promise<void> {
    try {
      await this.f(
        `${this.historyUrl}/api/mls/users/${encodeURIComponent(this.userId)}/dismissed-groups/${encodeURIComponent(groupId)}`,
        { method: 'DELETE', headers: await this.auth() }
      );
    } catch {
      /* non-blocking */
    }
  }

  /** Fetches group metadata - name, `deletedAt`. Returns `null` on 404 or error. */
  async getGroupMeta(groupId: string): Promise<GroupMeta | null> {
    try {
      const res = await this.f(`${this.historyUrl}/api/mls/groups/${encodeURIComponent(groupId)}`, {
        headers: await this.auth(),
      });
      if (!res.ok) return null;
      const g = await res.json();
      if (!g || typeof g !== 'object') return null;
      const id = (g as { id?: string; groupId?: string }).groupId ?? (g as { id?: string }).id;
      if (typeof id !== 'string' || !id) return null;
      return {
        groupId: id,
        name:
          typeof (g as { name?: string }).name === 'string'
            ? (g as { name: string }).name
            : undefined,
        isGroup:
          typeof (g as { isGroup?: boolean }).isGroup === 'boolean'
            ? (g as { isGroup: boolean }).isGroup
            : undefined,
        deletedAt: (g as { deletedAt?: string | null }).deletedAt ?? null,
      };
    } catch {
      return null;
    }
  }

  /** Returns outstanding Welcome invitations for a device (used by multi-device sync). */
  async getPendingInvitations(
    userId: string,
    deviceId: string
  ): Promise<
    Array<{ id: string; userId: string; deviceId: string; groupId: string; status: string }>
  > {
    try {
      const res = await this.f(
        `${this.historyUrl}/api/mls/invitations/pending/${userId}/${deviceId}`,
        {
          headers: await this.auth(),
        }
      );
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  /** Returns device-level membership rows for a device, including status (`pending`/`active`). */
  async getDeviceMemberships(
    userId: string,
    deviceId: string
  ): Promise<
    Array<{
      id: string;
      userId: string;
      deviceId: string;
      groupId: string;
      status: string;
    }>
  > {
    try {
      const res = await this.f(
        `${this.historyUrl}/api/mls/device-memberships/${userId}/${deviceId}`,
        {
          headers: await this.auth(),
        }
      );
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  /** Marks a device's group invitation as `pending` or `active`. Best-effort, non-throwing. */
  async updateInvitationStatus(
    deviceId: string,
    userId: string,
    groupId: string,
    status: 'pending' | 'active'
  ): Promise<void> {
    try {
      await this.f(`${this.historyUrl}/api/mls/invitations/status`, {
        method: 'POST',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ deviceId, userId, groupId, status }),
      });
    } catch (e) {
      console.error('Failed to update invitation status', e);
    }
  }

  /** Notifies the server to remove a stale leaf from the MLS tree (device lost its local state). Used alongside `removeMemberDevice` when a `DuplicateSignature` error is detected. */
  async kickStaleDevice(deviceId: string, userId: string, groupId: string): Promise<void> {
    const res = await this.f(`${this.historyUrl}/api/mls/kick-stale-device`, {
      method: 'POST',
      headers: await this.auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ deviceId, userId, groupId }),
    });
    if (!res.ok) throw new Error(`kickStaleDevice failed: ${res.status}`);
  }

  /** Deletes the membership row for a specific device+group pair. Returns `{ affected: 0 }` on error. */
  async deleteDeviceMembership(
    userId: string,
    deviceId: string,
    groupId: string
  ): Promise<{ status: string; affected: number }> {
    try {
      const res = await this.f(
        `${this.historyUrl}/api/mls/device-memberships/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}/${encodeURIComponent(groupId)}`,
        { method: 'DELETE', headers: await this.auth() }
      );
      if (!res.ok) {
        console.error(`deleteDeviceMembership failed: ${res.status}`);
        return { status: 'error', affected: 0 };
      }
      return await res.json();
    } catch (e) {
      console.error('Failed to delete device membership', e);
      return { status: 'error', affected: 0 };
    }
  }

  /** Deletes all group membership rows for a device (used when removing a device from the account). */
  async deleteAllDeviceMemberships(
    userId: string,
    deviceId: string
  ): Promise<{ status: string; affected: number }> {
    try {
      const res = await this.f(
        `${this.historyUrl}/api/mls/device-memberships/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}`,
        { method: 'DELETE', headers: await this.auth() }
      );
      if (!res.ok) {
        console.error(`deleteAllDeviceMemberships failed: ${res.status}`);
        return { status: 'error', affected: 0 };
      }
      return await res.json();
    } catch (e) {
      console.error('Failed to delete all device memberships', e);
      return { status: 'error', affected: 0 };
    }
  }

  async deleteDevice(
    userId: string,
    deviceId: string
  ): Promise<{
    status: string;
    groupsCleaned: number;
    keyPackagesDeleted: number;
    oneTimeKeyPackagesDeleted: number;
  }> {
    try {
      const res = await this.f(
        `${this.historyUrl}/api/mls/devices/${encodeURIComponent(userId)}/${encodeURIComponent(deviceId)}`,
        { method: 'DELETE', headers: await this.auth() }
      );
      if (!res.ok) {
        console.error(`deleteDevice failed: ${res.status}`);
        return {
          status: 'error',
          groupsCleaned: 0,
          keyPackagesDeleted: 0,
          oneTimeKeyPackagesDeleted: 0,
        };
      }
      return await res.json();
    } catch (e) {
      console.error('Failed to delete device', e);
      return {
        status: 'error',
        groupsCleaned: 0,
        keyPackagesDeleted: 0,
        oneTimeKeyPackagesDeleted: 0,
      };
    }
  }
}
