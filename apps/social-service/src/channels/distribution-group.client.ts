import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { callDelivery } from '../internal/delivery.client';

/**
 * THE ONE PLACE THIS SERVICE TALKS TO CHAT-DELIVERY ABOUT A COMMUNITY'S GRAINE DISTRIBUTION GROUP.
 *
 * WHY SOCIAL-SERVICE IS THE GATE. A distribution group is entered by external commit and therefore
 * holds no `dm_group_members` row, so chat-delivery's own MLS routes - which all gate on one - can
 * neither serve nor accept anything about it. The roster that governs it is COMMUNITY membership,
 * and `channel_members` lives here. Rather than teach chat-delivery to ask about a table it does not
 * own, the authorization stays in the service that holds the fact and the call goes the direction it
 * already goes: social -> delivery, secret-gated, never exposed through Nginx.
 *
 * The consequence worth stating: the GroupInfo IS the capability. Anyone holding it can external-
 * join, so handing it out is exactly the authorization decision, and it is made in `channel.service`
 * against `channel_workspace_members` before any function here is called.
 *
 * EVERY FUNCTION HERE THROWS ON FAILURE, AND THAT IS THE POINT. A transport failure is not an
 * answer: a community whose seeds cannot be reached must say so, not quietly behave as though it
 * had none. The mechanism is [delivery.client](../internal/delivery.client.ts), shared since
 * 2026-08-19 with the device lookup that used to fail OPEN and be the counter-example here.
 */

const logger = new Logger('DistributionGroup');

/**
 * Which roster a distribution group belongs to.
 *
 * `workspace` is a community: every member holds its seeds. `channel` is a PRIVATE salon: only the
 * people who may open it do. A public salon has no scope of its own - its audience IS the
 * community, so a second group would be the same set of people at a higher commit rate.
 */
export type DistributionScope = { kind: 'workspace' | 'channel'; id: string };

/** The scope's two path segments, and the one place they are spelled. */
function seg(scope: DistributionScope): string {
  return `${scope.kind}/${encodeURIComponent(scope.id)}`;
}

/** The scope as a log line names it. */
function label(scope: DistributionScope): string {
  return `${scope.kind}=${scope.id}`;
}

/** The community `workspaceId` belongs to, as a scope. */
export function workspaceScope(workspaceId: string): DistributionScope {
  return { kind: 'workspace', id: workspaceId };
}

/** The PRIVATE salon `channelId`, as a scope. Never call this for a public one - see the routes. */
export function channelScope(channelId: string): DistributionScope {
  return { kind: 'channel', id: channelId };
}

/** The distribution group of a scope, and what has been published on it so far. */
export interface DistributionGroupRef {
  /** `dm_groups.id` of the scope's key-distribution group. */
  groupId: string;
  /**
   * Latest published GroupInfo (base64), or null when no client has initialised the MLS group yet.
   * Null is a real state - the scope exists and nobody has opened it yet - never an error, and the
   * caller must be able to tell the two apart.
   */
  groupInfo: string | null;
  /** Epoch the GroupInfo above was published at; null exactly when `groupInfo` is. */
  baseEpoch: number | null;
  /**
   * The group's REAL epoch on the server, whatever was published.
   *
   * `baseEpoch < activeEpoch` means the published base is unusable: the commit gate accepts only a
   * base equal to the active epoch, so an external join built on it is refused every time. The two
   * numbers separate for good whenever the republish that follows an accepted commit is lost, and
   * only a device HOLDING the tree can mint a fresh base - so this is the fact that tells a joiner
   * not to try and tells a holder to repair. Never null: a group always has an epoch.
   */
  activeEpoch: number;
  /**
   * Device ids of the reader this was read FOR that the group holds a membership row for.
   *
   * Undefined when the read did not name a reader - "nobody asked", which a client must not read as
   * "no devices". Present and EMPTY is the answer that matters: the group would deliver nothing to
   * that user, whatever their client believes about having joined.
   */
  memberDevices?: string[];
  /**
   * The ASKING DEVICE's own seat, read by chat-delivery AFTER the base above, so a base an Add stored
   * always comes with that Add's seat (channel-encryption section 20, one door at a time). Present
   * only when the read named a device. `addInFlight` is absent when the add lock could not be read:
   * unknown, never `false`.
   */
  seat?: DistributionSeat;
}

/** One device's seat in a key group, as chat-delivery serves it with the base. */
export type DistributionSeat =
  | { status: 'none' | 'active' }
  | { status: 'pending'; welcomeQueued: boolean; addInFlight?: boolean };

/** Shape chat-delivery answers with on the distribution-group routes. */
interface DeliveryGroupPayload {
  groupId?: unknown;
  groupInfo?: unknown;
  baseEpoch?: unknown;
  activeEpoch?: unknown;
  memberDevices?: unknown;
  seat?: unknown;
}

/**
 * Passes a served seat through only in a shape the client can read; anything else is dropped, and
 * the client then reads "no seat answer", which opens no door (it never reads as "nothing owed").
 */
function parseSeat(raw: unknown): DistributionSeat | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as { status?: unknown; welcomeQueued?: unknown; addInFlight?: unknown };
  if (s.status === 'none' || s.status === 'active') return { status: s.status };
  if (s.status !== 'pending' || typeof s.welcomeQueued !== 'boolean') return undefined;
  return {
    status: 'pending',
    welcomeQueued: s.welcomeQueued,
    ...(typeof s.addInFlight === 'boolean' ? { addInFlight: s.addInFlight } : {}),
  };
}

/**
 * Creates a scope's distribution group, or returns the one it already has.
 *
 * Idempotent on the delivery side through a partial unique index, so calling it twice for the same
 * scope is safe and returns the same id - which is what makes it usable both when a community or a
 * private salon is created, and as a repair for one that predates its scope.
 *
 * @param scope the community, or the PRIVATE salon, the group belongs to
 * @returns `dm_groups.id` of the distribution group
 */
export async function createDistributionGroup(
  secret: string,
  scope: DistributionScope
): Promise<string> {
  const payload = (await callDelivery(
    secret,
    'DISTRIBUTION_GROUP',
    'internal/mls/distribution-groups',
    { method: 'POST', body: { scope: scope.kind, scopeId: scope.id } }
  )) as DeliveryGroupPayload | null;

  const groupId = typeof payload?.groupId === 'string' ? payload.groupId : '';
  if (!groupId) {
    logger.error(`[DISTRIBUTION_GROUP] create ${label(scope)} answered no groupId`);
    throw new ServiceUnavailableException('Key distribution is unavailable.');
  }
  return groupId;
}

/**
 * Reads a scope's distribution group and its latest GroupInfo.
 *
 * @returns null when the scope has no distribution group at all - distinct from a group with
 *   nothing published on it yet, which comes back with `groupInfo: null`.
 */
export async function readDistributionGroup(
  secret: string,
  scope: DistributionScope,
  forUserId?: string,
  forDeviceId?: string
): Promise<DistributionGroupRef | null> {
  // Named ON THE READ rather than inferred later: only the delivery side holds the membership rows,
  // and a caller that did not ask gets `memberDevices: undefined` instead of a misleading empty list.
  const reader = String(forUserId ?? '')
    .trim()
    .toLowerCase();
  // The device is self-asserted and only ever reads its OWN seat among the reader's rows.
  const device = reader ? String(forDeviceId ?? '').trim() : '';
  const query = reader
    ? `?userId=${encodeURIComponent(reader)}` +
      (device ? `&deviceId=${encodeURIComponent(device)}` : '')
    : '';
  const payload = (await callDelivery(
    secret,
    'DISTRIBUTION_GROUP',
    `internal/mls/distribution-groups/${seg(scope)}${query}`,
    { method: 'GET' }
  )) as DeliveryGroupPayload | null;

  const groupId = typeof payload?.groupId === 'string' ? payload.groupId : '';
  if (!groupId) return null;

  const devices = Array.isArray(payload?.memberDevices)
    ? payload.memberDevices.filter((d): d is string => typeof d === 'string')
    : undefined;

  const baseEpoch = typeof payload?.baseEpoch === 'number' ? payload.baseEpoch : null;
  const seat = device ? parseSeat(payload?.seat) : undefined;
  return {
    groupId,
    groupInfo: typeof payload?.groupInfo === 'string' ? payload.groupInfo : null,
    baseEpoch,
    // Falls back to the base rather than to 0: an older delivery build that does not send the field
    // must read as "nothing known to be stale", never as "every base is ahead of the group".
    activeEpoch: typeof payload?.activeEpoch === 'number' ? payload.activeEpoch : (baseEpoch ?? 0),
    ...(devices ? { memberDevices: devices } : {}),
    ...(seat ? { seat } : {}),
  };
}

/**
 * Publishes a new GroupInfo for a scope's distribution group. Monotonic on the far side.
 *
 * **TWO FACTS COME BACK, NOT ONE.** The same call also puts the publishing device into the group's
 * delivery roster, and that half can be refused on its own - a revoked device, or one with no key
 * package, is not routed to. It used to be refused silently: delivery dropped the outcome and this
 * returned `stored` alone, so a publisher that was the group's ONLY possible Welcome server could
 * be excluded from it with nothing said anywhere a reader would look.
 *
 * `publisherActive` defaults to TRUE when the field is absent, for the same reason `activeEpoch`
 * above falls back to the base: an older delivery build that does not send it must read as "nothing
 * known to be wrong", never as a refusal that never happened.
 */
export async function publishDistributionGroupInfo(
  secret: string,
  scope: DistributionScope,
  groupInfo: string,
  baseEpoch: number,
  publisher: { userId: string; deviceId: string }
): Promise<{ stored: boolean; publisherActive: boolean }> {
  const payload = (await callDelivery(
    secret,
    'DISTRIBUTION_GROUP',
    `internal/mls/distribution-groups/${seg(scope)}/group-info`,
    { method: 'POST', body: { groupInfo, baseEpoch, ...publisher } }
  )) as { stored?: unknown; publisherActive?: unknown } | null;

  return { stored: payload?.stored === true, publisherActive: payload?.publisherActive !== false };
}

/**
 * Cuts one user off a scope's key-distribution group, immediately and server-side.
 *
 * Called the moment they stop belonging to that roster, whichever way that happened - leaving or
 * being kicked from a community, or losing access to a private salon. It revokes DELIVERY: their
 * devices stop being routed the seed frames, and anything already queued for them is dropped. The
 * MLS half - removing their leaf so future seeds are not even sealed to it - is a commit, which
 * only a member's device can produce, and lands when one next loads the community or salon.
 *
 * Idempotent, so a departure that is retried costs nothing.
 *
 * THE THREE COUNTS AND THE FLAG ARE ALL CARRIED, because the caller cannot recover any of them.
 * This used to return `memberships` and `queued` alone, so the log line downstream had no `routes`
 * to print and printed `memberships` under that name - a lie for as long as the two agreed, which
 * on a one-device leaver is always. And dropping `evicted` collapsed "a scope that has no
 * distribution group" into "a cut that found nothing": the discriminator is KNOWN here and the
 * decision is made there, so it travels rather than being guessed from three zeros.
 *
 * TWO CALLS PER DEPARTURE, AND THE SECOND NAMES THE FIRST. The one made before the roster write
 * BEGINS a departure on chat-delivery, where no seat is written for that person meanwhile, and
 * answers its name (`departure`), which the roster write records in its own transaction
 * (`ChannelService.departDistributionGroups`). The one made after it (`settles`) settles that
 * departure. A second call that never arrives is settled by chat-delivery's hourly drain, which asks
 * this service how that named departure ended.
 *
 * @param settles the departure the first call named, for the eviction made once the roster row is
 *   gone; absent for the first call
 * @returns whether there was a group at all, how many rows, Redis routes and queued frames went,
 *   and - on a first call to a group - the departure it began
 */
export async function evictFromDistributionGroup(
  secret: string,
  scope: DistributionScope,
  userId: string,
  settles?: number
): Promise<{
  evicted: boolean;
  memberships: number;
  queued: number;
  routes: number;
  begun: { groupId: string; departure: number } | null;
}> {
  const payload = (await callDelivery(
    secret,
    'DISTRIBUTION_GROUP',
    `internal/mls/distribution-groups/${seg(scope)}/members/${encodeURIComponent(userId)}` +
      (settles === undefined ? '' : `?phase=after_roster_write&departure=${settles}`),
    { method: 'DELETE' }
  )) as {
    evicted?: unknown;
    memberships?: unknown;
    queued?: unknown;
    routes?: unknown;
    groupId?: unknown;
    departure?: unknown;
  } | null;

  return {
    evicted: payload?.evicted === true,
    memberships: typeof payload?.memberships === 'number' ? payload.memberships : 0,
    queued: typeof payload?.queued === 'number' ? payload.queued : 0,
    routes: typeof payload?.routes === 'number' ? payload.routes : 0,
    begun:
      typeof payload?.groupId === 'string' && typeof payload?.departure === 'number'
        ? { groupId: payload.groupId, departure: payload.departure }
        : null,
  };
}

/**
 * Tells chat-delivery that the departure `departure` was abandoned before its roster write and
 * recorded `cancelled` here, so it settles it with nothing evicted - the person is still a member.
 *
 * @returns whether that departure was the one in progress there and is now settled
 */
export async function cancelDistributionDeparture(
  secret: string,
  scope: DistributionScope,
  userId: string,
  departure: number
): Promise<boolean> {
  const payload = (await callDelivery(
    secret,
    'DISTRIBUTION_GROUP',
    `internal/mls/distribution-groups/${seg(scope)}/members/${encodeURIComponent(userId)}` +
      `/departures/${departure}/cancel`,
    { method: 'POST' }
  )) as { settled?: unknown } | null;
  logger.log(
    `[DISTRIBUTION_GROUP] cancel ${label(scope)} user=${userId.slice(0, 8)} departure=${departure} ` +
      `settled=${payload?.settled === true}`
  );
  return payload?.settled === true;
}

/** Tombstones a scope's distribution group. Returns false when there was none to delete. */
export async function deleteDistributionGroup(
  secret: string,
  scope: DistributionScope
): Promise<boolean> {
  const payload = (await callDelivery(
    secret,
    'DISTRIBUTION_GROUP',
    `internal/mls/distribution-groups/${seg(scope)}`,
    { method: 'DELETE' }
  )) as { deleted?: unknown } | null;

  return payload?.deleted === true;
}
