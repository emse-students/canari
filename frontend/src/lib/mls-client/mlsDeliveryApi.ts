import { assertOkMlsDeliveryResponse, deliveryKeepalivePost } from './mlsDeliveryHttp';
import { ackMessagesWithRetry } from './ackRetry';
import type { GroupMeta, UserGroupRow } from './IMlsService';
import { toBase64, fromBase64 } from '$lib/utils/hex';

export type MlsDeliveryFetch = typeof fetch;

/**
 * TTL du verrou add (serialisation cross-device des commits d'ajout). Dimensionne sur le pire
 * cas mobile reel : bulk add + persist Argon2 (~5-8 s) + commit valide + boucle de Welcomes, qui
 * depasse facilement les 10 s d'origine -> le verrou expirait en cours d'operation -> deux devices
 * committaient en parallele -> fork d'epoch sur le successeur (H1). [[H1]]
 */
export const MLS_ADD_LOCK_TTL_MS = 30_000;

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

  /** Fire-and-forget POST to the delivery service; throws on non-2xx. */
  async deliveryPost(path: string, body: Record<string, unknown>): Promise<void> {
    await deliveryKeepalivePost(
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

  /** Raw JSON rows from `GET /api/mls/messages/:userId/:deviceId` (pending queue). */
  async pullPendingMessagesJson(signal?: AbortSignal): Promise<unknown[]> {
    if (this.userId === 'unknown') return [];

    const all: unknown[] = [];
    const pageLimit = 500;
    let afterCreatedAt: string | undefined;

    while (true) {
      const url = new URL(`${this.historyUrl}/api/mls/messages/${this.userId}/${this.deviceId}`);
      url.searchParams.set('limit', String(pageLimit));
      if (afterCreatedAt) url.searchParams.set('after', afterCreatedAt);

      const res = await this.f(url.toString(), {
        headers: await this.auth(),
        signal,
      });
      if (!res.ok) break;

      const batch = (await res.json()) as Array<{ createdAt?: string }>;
      if (!Array.isArray(batch) || batch.length === 0) break;

      all.push(...batch);
      if (batch.length < pageLimit) break;

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
   * THROWS sur un echec transport/HTTP (reseau coupe, non-2xx) : un `[]` ne doit JAMAIS etre
   * indiscernable d'un echec (cf. audit S2). Ne renvoie `[]` que pour un vrai 200 sans device.
   * Les appelants best-effort (creation, fallback KeyPackage) opt-in explicitement via
   * `.catch(() => [])` ; le chemin d'invitation laisse l'erreur remonter pour ne pas inviter un
   * sous-ensemble silencieux de membres.
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
   */
  async fetchGroupInfo(groupId: string): Promise<{ groupInfo: string; baseEpoch: number } | null> {
    const res = await this.f(
      `${this.historyUrl}/api/mls/group-info/${encodeURIComponent(groupId)}`,
      { headers: await this.auth() }
    );
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
   */
  async storeGroupInfo(groupId: string, groupInfoBase64: string, baseEpoch: number): Promise<void> {
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

  /** POSTs an already-encrypted MLS ciphertext to `/api/mls/send` without epoch validation. Used by Tauri (native MLS handles epoch tracking internally). */
  async postApplicationMessage(
    groupId: string,
    protoBase64: string,
    silent = false
  ): Promise<void> {
    const res = await this.f(`${this.historyUrl}/api/mls/send`, {
      method: 'POST',
      headers: await this.auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        senderId: this.userId,
        senderDeviceId: this.deviceId,
        groupId,
        proto: protoBase64,
        silent,
      }),
    });
    if (!res.ok) {
      throw new Error(`Message send HTTP error: ${res.status}`);
    }
  }

  /** Fetches the Redis Stream history for a group, optionally paginated after `afterStreamId`. Returns `[]` on error. */
  async fetchHistory(
    groupId: string,
    afterStreamId?: string,
    limit?: number
  ): Promise<import('$lib/mls-client/historyTypes').HistoryStreamRow[]> {
    try {
      const url = new URL(`${this.historyUrl}/api/mls/history/${groupId}`);
      if (afterStreamId) url.searchParams.set('after', afterStreamId);
      const effectiveLimit = limit !== undefined ? String(limit) : afterStreamId ? '200' : '1000';
      url.searchParams.set('limit', effectiveLimit);
      const res = await this.f(url.toString(), {
        headers: await this.auth(),
      });
      if (!res.ok) return [];
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('application/json')) {
        console.warn(
          `[History] Non-JSON response for group ${groupId}. Received content-type: ${contentType || 'unknown'}`
        );
        return [];
      }
      return await res.json();
    } catch (e) {
      console.error('Fetch History Error:', e);
      return [];
    }
  }

  /**
   * Fetches the first history page for multiple groups in one request (login catch-up).
   * Falls back to sequential {@link fetchHistory} when the batch route is unavailable.
   */
  async fetchHistoryBatch(
    groups: Array<{ groupId: string; afterStreamId?: string }>
  ): Promise<Map<string, import('$lib/mls-client/historyTypes').HistoryStreamRow[]>> {
    const out = new Map<string, import('$lib/mls-client/historyTypes').HistoryStreamRow[]>();
    if (groups.length === 0) return out;

    try {
      const res = await this.f(`${this.historyUrl}/api/mls/history/batch`, {
        method: 'POST',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          groups: groups.map((g) => ({
            groupId: g.groupId,
            after: g.afterStreamId,
          })),
        }),
      });
      if (res.ok) {
        const contentType = res.headers.get('content-type') ?? '';
        if (contentType.toLowerCase().includes('application/json')) {
          const data = (await res.json()) as {
            histories?: Record<string, import('$lib/mls-client/historyTypes').HistoryStreamRow[]>;
          };
          for (const [groupId, rows] of Object.entries(data.histories ?? {})) {
            out.set(groupId, rows ?? []);
          }
          return out;
        }
      }
      console.warn(`[History] batch fetch failed (${res.status}), falling back to sequential`);
    } catch (e) {
      console.warn('[History] batch fetch error, falling back to sequential:', e);
    }

    for (const g of groups) {
      out.set(g.groupId, await this.fetchHistory(g.groupId, g.afterStreamId));
    }
    return out;
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
   * THROWS sur echec transport/HTTP : un `[]` ne doit pas masquer un echec reseau (audit S2).
   * Ne renvoie `[]` que pour un vrai 200 sans membre. Les appelants tolerants opt-in via `.catch`.
   */
  async getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]> {
    const res = await this.f(`${this.historyUrl}/api/mls/groups/${groupId}/members`, {
      headers: await this.auth(),
    });
    if (!res.ok) throw new Error(`getGroupMembers failed: ${res.status}`);
    return await res.json();
  }

  /**
   * Returns user-level members from dm_group_members for `groupId`.
   * THROWS sur echec transport/HTTP : un `[]` ne doit pas masquer un echec reseau (audit S2).
   * Ne renvoie `[]` que pour un vrai 200 sans membre. Les appelants tolerants opt-in via `.catch`.
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
   * Statut serveur d'un groupe, en distinguant absence CONFIRMEE et incertitude reseau - ce que
   * `getGroupMeta` (qui renvoie `null` pour les deux) ne permet pas. `GET /api/mls/groups/:id`
   * interroge `dm_groups` SANS controle de membership et renvoie `null` (corps) si la ligne
   * n'existe pas, donc :
   *  - `'absent'` : le serveur a repondu et la ligne `dm_groups` n'existe pas -> groupe vraiment
   *    disparu (jamais cree / hard-purge). Seul cas ou la discovery doit auto-supprimer la conv.
   *  - `'error'`  : echec HTTP/reseau -> statut inconnu, ne RIEN supprimer.
   *  - `GroupMeta`: la ligne existe (groupe vivant, tombstone `deletedAt`, ou exclusion) -> garder
   *    la conv localement (banniere + suppression manuelle).
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
    // 404 = aucune ligne dm_groups -> absent confirme (jamais cree ou hard-purge).
    if (res.status === 404) return 'absent';
    // Autre non-2xx (401/5xx/…) = doute reel -> ne jamais purger sur erreur.
    if (!res.ok) return 'error';
    // Le handler `GET mls/groups/:id` renvoie l'objet groupe, ou `null` quand il est introuvable.
    // NestJS serialise ce `null` en un corps VIDE (200) -> `res.json()` jetterait. Un corps 2xx
    // vide ou "null" depuis CET endpoint signifie donc sans ambiguite "groupe absent" (et non une
    // erreur reseau). C'est la distinction qui permet a la discovery de purger un groupe supprime
    // au lieu de le conserver indefiniment comme "statut incertain". [[lifecycle]]
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
    };
  }

  /**
   * Liste les groupes que CET utilisateur a volontairement dismisses (suppression/quitter manuel).
   * La discovery purge toute conversation locale presente dans cet ensemble - sur tous les
   * appareils de l'utilisateur. Retourne `[]` en cas d'echec (on ne purge jamais sur un doute).
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

  /** Marque un groupe comme dismisse par cet utilisateur (suppression/quitter manuel propage a ses appareils). Best-effort. */
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
      /* non-bloquant : la purge locale a deja eu lieu, les autres appareils retenteront */
    }
  }

  /** Leve le dismiss d'un groupe (re-ajout via Welcome : l'utilisateur veut de nouveau la conversation). Best-effort. */
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
