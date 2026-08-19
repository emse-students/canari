import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { DELIVERY_TIMEOUT_MS, deliveryUrl } from '../internal/service-urls';

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
 * EVERY FUNCTION HERE THROWS ON FAILURE, AND THAT IS THE POINT. `userHasMlsDevices` in
 * `channel.service` fails open, and the day its URL was wrong that turned a guard into a constant
 * `true` - a check nobody had. A transport failure is not an answer: a community whose seeds cannot
 * be reached must say so, not quietly behave as though it had none.
 */

const logger = new Logger('DistributionGroup');

/** The distribution group of a community, and what has been published on it so far. */
export interface DistributionGroupRef {
  /** `dm_groups.id` of the community's key-distribution group. */
  groupId: string;
  /**
   * Latest published GroupInfo (base64), or null when no client has initialised the MLS group yet.
   * Null is a real state - the community exists and nobody has opened a salon in it - never an
   * error, and the caller must be able to tell the two apart.
   */
  groupInfo: string | null;
  /** Epoch the GroupInfo above was published at; null exactly when `groupInfo` is. */
  baseEpoch: number | null;
}

/** Shape chat-delivery answers with on the distribution-group routes. */
interface DeliveryGroupPayload {
  groupId?: unknown;
  groupInfo?: unknown;
  baseEpoch?: unknown;
}

/**
 * Performs one internal call and refuses to interpret anything but a status code.
 *
 * @throws ServiceUnavailableException when the call could not be completed, or answered non-2xx.
 */
async function callDelivery(
  secret: string,
  path: string,
  init: { method: 'GET' | 'POST' | 'DELETE'; body?: unknown }
): Promise<unknown> {
  if (!secret) {
    // Fails closed, like every other internal-secret check in the monorepo: an unset secret means
    // the deployment is misconfigured, and pretending the community has no seeds would hide it.
    logger.error(`[DISTRIBUTION_GROUP] INTERNAL_SECRET unset - refusing ${init.method} ${path}`);
    throw new ServiceUnavailableException('Key distribution is unavailable.');
  }

  let res: Response;
  try {
    res = await fetch(deliveryUrl(path), {
      method: init.method,
      headers: {
        'X-Internal-Secret': secret,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch (e) {
    logger.error(
      `[DISTRIBUTION_GROUP] ${init.method} ${path} unreachable: ${e instanceof Error ? e.message : String(e)}`
    );
    throw new ServiceUnavailableException('Key distribution is unavailable.');
  }

  if (!res.ok) {
    logger.error(`[DISTRIBUTION_GROUP] ${init.method} ${path} answered ${res.status}`);
    throw new ServiceUnavailableException('Key distribution is unavailable.');
  }

  // 204 and an empty body are legitimate answers on the DELETE route.
  const text = await res.text();
  return text.length === 0 ? null : (JSON.parse(text) as unknown);
}

/**
 * Creates the community's distribution group, or returns the one it already has.
 *
 * Idempotent on the delivery side through a partial unique index, so calling it twice for the same
 * community is safe and returns the same id - which is what makes it usable both when a community
 * is created and as a repair for one predating Graine.
 *
 * @param workspaceId the community the group belongs to
 * @returns `dm_groups.id` of the distribution group
 */
export async function createDistributionGroup(
  secret: string,
  workspaceId: string
): Promise<string> {
  const payload = (await callDelivery(secret, 'internal/mls/distribution-groups', {
    method: 'POST',
    body: { workspaceId },
  })) as DeliveryGroupPayload | null;

  const groupId = typeof payload?.groupId === 'string' ? payload.groupId : '';
  if (!groupId) {
    logger.error(`[DISTRIBUTION_GROUP] create workspace=${workspaceId} answered no groupId`);
    throw new ServiceUnavailableException('Key distribution is unavailable.');
  }
  return groupId;
}

/**
 * Reads the community's distribution group and its latest GroupInfo.
 *
 * @returns null when the community has no distribution group at all - distinct from a group with
 *   nothing published on it yet, which comes back with `groupInfo: null`.
 */
export async function readDistributionGroup(
  secret: string,
  workspaceId: string
): Promise<DistributionGroupRef | null> {
  const payload = (await callDelivery(
    secret,
    `internal/mls/distribution-groups/${encodeURIComponent(workspaceId)}`,
    { method: 'GET' }
  )) as DeliveryGroupPayload | null;

  const groupId = typeof payload?.groupId === 'string' ? payload.groupId : '';
  if (!groupId) return null;

  return {
    groupId,
    groupInfo: typeof payload?.groupInfo === 'string' ? payload.groupInfo : null,
    baseEpoch: typeof payload?.baseEpoch === 'number' ? payload.baseEpoch : null,
  };
}

/** Publishes a new GroupInfo for the community's distribution group. Monotonic on the far side. */
export async function publishDistributionGroupInfo(
  secret: string,
  workspaceId: string,
  groupInfo: string,
  baseEpoch: number
): Promise<{ stored: boolean }> {
  const payload = (await callDelivery(
    secret,
    `internal/mls/distribution-groups/${encodeURIComponent(workspaceId)}/group-info`,
    { method: 'POST', body: { groupInfo, baseEpoch } }
  )) as { stored?: unknown } | null;

  return { stored: payload?.stored === true };
}

/**
 * Cuts one user off the community's key-distribution group, immediately and server-side.
 *
 * Called the moment they stop being a member, whichever way that happened. It revokes DELIVERY:
 * their devices stop being routed the seed frames, and anything already queued for them is
 * dropped. The MLS half - removing their leaf so future seeds are not even sealed to it - is a
 * commit, which only a member's device can produce, and lands when one next loads the community.
 *
 * Idempotent, so a departure that is retried costs nothing.
 *
 * THE THREE COUNTS AND THE FLAG ARE ALL CARRIED, because the caller cannot recover any of them.
 * This used to return `memberships` and `queued` alone, so the log line downstream had no `routes`
 * to print and printed `memberships` under that name - a lie for as long as the two agreed, which
 * on a one-device leaver is always. And dropping `evicted` collapsed "a community that has no
 * distribution group" into "a cut that found nothing": the discriminator is KNOWN here and the
 * decision is made there, so it travels rather than being guessed from three zeros.
 *
 * @returns whether there was a group at all, and how many rows, Redis routes and queued frames went
 */
export async function evictFromDistributionGroup(
  secret: string,
  workspaceId: string,
  userId: string
): Promise<{ evicted: boolean; memberships: number; queued: number; routes: number }> {
  const payload = (await callDelivery(
    secret,
    `internal/mls/distribution-groups/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' }
  )) as { evicted?: unknown; memberships?: unknown; queued?: unknown; routes?: unknown } | null;

  return {
    evicted: payload?.evicted === true,
    memberships: typeof payload?.memberships === 'number' ? payload.memberships : 0,
    queued: typeof payload?.queued === 'number' ? payload.queued : 0,
    routes: typeof payload?.routes === 'number' ? payload.routes : 0,
  };
}

/** Tombstones the community's distribution group. Returns false when there was none to delete. */
export async function deleteDistributionGroup(
  secret: string,
  workspaceId: string
): Promise<boolean> {
  const payload = (await callDelivery(
    secret,
    `internal/mls/distribution-groups/${encodeURIComponent(workspaceId)}`,
    { method: 'DELETE' }
  )) as { deleted?: unknown } | null;

  return payload?.deleted === true;
}
