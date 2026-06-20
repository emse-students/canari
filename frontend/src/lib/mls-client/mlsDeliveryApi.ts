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

/**
 * TTL du verrou reboot (exclusion mutuelle de la fork-resolution). Plus long que l'add-lock : un
 * reboot enchaine creation du candidat + CAS + invitation des membres + persist Argon2 + bundle
 * historique, ce qui peut depasser les 60 s d'origine sur mobile -> reboot concurrent -> pollution
 * serveur (le CAS converge mais apres degats). [[H1]]
 */
export const MLS_REBOOT_LOCK_TTL_MS = 90_000;

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

  /** Fetches KeyPackages for all active devices of `userId`. Returns `[]` on any error. */
  async fetchUserDevices(userId: string): Promise<
    Array<{
      keyPackage: Uint8Array;
      deviceId: string;
      deviceName?: string;
      deviceOs?: string;
      deviceAppVersion?: string;
    }>
  > {
    try {
      const res = await this.f(`${this.historyUrl}/api/mls/devices/${userId}`, {
        headers: await this.auth(),
      });
      if (!res.ok) return [];
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
    } catch (e) {
      console.error('Fetch User Devices Error:', e);
      return [];
    }
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
      throw new Error(
        `Impossible d'envoyer l'invitation sécurisée à ${targetUserId} : ` +
          `aucun appareil actif trouvé.`
      );
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
   * Validates a commit's epoch against the server (`POST /api/mls/commit`) WITHOUT broadcasting.
   * Returns the raw validation result (`accepted`, `reason`, `currentEpoch`, `newEpoch`) so the
   * caller can decide what to do : le chemin add (commit deja merge) diffuse directement via
   * `sendValidatedCommit` ; le chemin REMOVE en Option A (commit *stage*) merge localement APRES
   * acceptation puis diffuse, ou annule le commit stage sur rejet - jamais de fork. [[C7]]
   * Throws only on transport/HTTP failure (pas sur un rejet metier).
   */
  async validateCommitEpoch(
    groupId: string,
    baseEpoch: number
  ): Promise<{ accepted: boolean; reason?: string; currentEpoch?: number; newEpoch?: number }> {
    const validateRes = await this.f(`${this.historyUrl}/api/mls/commit`, {
      method: 'POST',
      headers: await this.auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ groupId, deviceId: this.deviceId, baseEpoch }),
    });
    if (!validateRes.ok) {
      throw new Error(`Commit validation HTTP error: ${validateRes.status}`);
    }
    return validateRes.json();
  }

  /** Broadcasts an already-validated commit to all group members (`POST /api/mls/send`, isCommit). */
  async broadcastCommit(
    protoBase64: string,
    groupId: string,
    excludeDeviceIds?: string[]
  ): Promise<void> {
    const res = await this.f(`${this.historyUrl}/api/mls/send`, {
      method: 'POST',
      headers: await this.auth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        senderId: this.userId,
        senderDeviceId: this.deviceId,
        groupId,
        proto: protoBase64,
        isCommit: true,
        ...(excludeDeviceIds?.length ? { excludeDeviceIds } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`Commit delivery HTTP error: ${res.status}`);
    }
  }

  /**
   * Validates then broadcasts an MLS commit (chemin ADD : le commit est deja merge localement).
   * `baseEpoch` is the epoch before the commit was applied, computed by the caller
   * (WebMlsService/TauriMlsService). Sur rejet, throw avec le motif `server epoch:.., sent:..`
   * que `parseForkedEpoch` reconnait pour declencher la heal C7-B (l'add a deja forke localement).
   */
  async sendValidatedCommit(
    protoBase64: string,
    groupId: string,
    baseEpoch: number,
    excludeDeviceIds?: string[]
  ): Promise<void> {
    const validation = await this.validateCommitEpoch(groupId, baseEpoch);
    if (!validation.accepted) {
      throw new Error(
        `Commit rejected: ${validation.reason || 'epoch_mismatch'} (server epoch: ${validation.currentEpoch}, sent: ${baseEpoch})`
      );
    }
    await this.broadcastCommit(protoBase64, groupId, excludeDeviceIds);
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
      // Fail-safe : on ne peut pas prouver que le lock a été acquis → supposer que non.
      // Retourner true ici autoriserait des commits concurrents si Redis est temporairement
      // indisponible, ce qui fragmenterait les epochs et désynchroniserait les WASM locaux.
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
      /* non-bloquant */
    }
  }

  /**
   * Acquires the cross-device reboot lock for `groupId` (fork-resolution mutual exclusion).
   * Returns `false` if another device already owns the reboot - the caller must then abstain
   * and rely on the successor being joined via retries (watchdog / checkGroupSuccessors).
   * TTL longer than add-lock: a reboot chains candidate creation + CAS + member invitations.
   */
  async acquireRebootLock(groupId: string, ttlMs = MLS_REBOOT_LOCK_TTL_MS): Promise<boolean> {
    try {
      const res = await this.f(`${this.historyUrl}/api/mls/reboot-lock`, {
        method: 'POST',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ groupId, deviceId: this.deviceId, ttlMs }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      return data.acquired === true;
    } catch {
      // Fail-safe : Redis indisponible → on suppose le lock NON acquis. Le CAS reste le
      // garde-fou de correction (un seul successeur), ce verrou n'est qu'une optimisation
      // anti-pollution ; mieux vaut s'abstenir que de lancer un reboot non protégé.
      return false;
    }
  }

  /** Releases the reboot-lock previously acquired by {@link acquireRebootLock}. Best-effort. */
  async releaseRebootLock(groupId: string): Promise<void> {
    try {
      await this.f(`${this.historyUrl}/api/mls/reboot-lock`, {
        method: 'DELETE',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ groupId, deviceId: this.deviceId }),
      });
    } catch {
      /* non-bloquant */
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
   * Liste les one-time prekeys publiés de ce device (id + payload décodé), pour que le
   * client valide localement lesquels il possède encore en clé privée. Retourne `[]` sur erreur.
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

  /** Supprime des one-time prekeys ciblés par id (orphelins de leur clé privée locale). */
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

  /** Clears the pending `welcome_request` queue for `groupId` after a successful reboot. */
  async clearPendingWelcomeRequests(groupId: string): Promise<void> {
    const res = await this.f(
      `${this.historyUrl}/api/mls/welcome-request/group/${encodeURIComponent(groupId)}`,
      { method: 'DELETE', headers: await this.auth() }
    );
    if (!res.ok) throw new Error(`clearPendingWelcomeRequests failed: ${res.status}`);
  }

  /** Soft-deletes `groupId` (and its successor chain) on the server. Returns `false` if already absent (404). */
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

  /** Returns the current member list for `groupId`. Returns `[]` on error. */
  async getGroupMembers(groupId: string): Promise<{ userId: string; deviceId: string }[]> {
    try {
      const res = await this.f(`${this.historyUrl}/api/mls/groups/${groupId}/members`, {
        headers: await this.auth(),
      });
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  /** Returns user-level members from dm_group_members for `groupId`. Returns `[]` on error. */
  async getGroupUserMembers(groupId: string): Promise<{ userId: string }[]> {
    try {
      const res = await this.f(`${this.historyUrl}/api/mls/groups/${groupId}/user-members`, {
        headers: await this.auth(),
      });
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  /** Returns all groups `userId` belongs to, including tombstones with successor/deleted metadata. */
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
    if (!res.ok) return 'error';
    let g: unknown;
    try {
      g = await res.json();
    } catch {
      return 'error';
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
      successorId: (g as { successorId?: string | null }).successorId ?? null,
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
      /* non-bloquant */
    }
  }

  /** Fetches group metadata - name, `successorId`, `deletedAt`. Returns `null` on 404 or error. */
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
        successorId: (g as { successorId?: string | null }).successorId ?? null,
        deletedAt: (g as { deletedAt?: string | null }).deletedAt ?? null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Atomic CAS: claims `successorId` as the replacement for dead group `deadGroupId`.
   * Returns `{ claimed: true }` if this device won the race, or `{ claimed: false, successorId }` with the winner's ID if another device was faster.
   * `claimedByDeviceId` is recorded server-side (diagnostic only) to attribute the reboot to the initiating device.
   */
  async claimGroupSuccessor(
    deadGroupId: string,
    successorId: string,
    claimedByDeviceId?: string
  ): Promise<{ claimed: boolean; successorId: string | null }> {
    const res = await this.f(
      `${this.historyUrl}/api/mls/groups/${encodeURIComponent(deadGroupId)}/successor`,
      {
        method: 'POST',
        headers: await this.auth({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ successorId, claimedByDeviceId }),
      }
    );
    const json: Record<string, unknown> = await res.json().catch(() => ({}));
    if (res.ok) {
      return {
        claimed: json.claimed === true,
        successorId: typeof json.successorId === 'string' ? json.successorId : successorId,
      };
    }
    if (res.status === 409) {
      const payload =
        json.message && typeof json.message === 'object' && json.message !== null
          ? (json.message as Record<string, unknown>)
          : json;
      return {
        claimed: false,
        successorId: typeof payload.successorId === 'string' ? payload.successorId : null,
      };
    }
    throw new Error(`claimGroupSuccessor failed: ${res.status}`);
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
