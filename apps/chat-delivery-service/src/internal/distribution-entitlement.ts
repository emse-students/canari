import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { Group } from '../entities/group.entity';
import { socialUrl } from './service-urls';

const logger = new Logger('DistributionEntitlement');

/** The scope that owns a key-distribution group: a community, or a private salon. */
export interface DistributionScope {
  kind: 'workspace' | 'channel';
  id: string;
}

/**
 * The scope of a key-distribution group, or `null` for a conversation (exactly one of the two
 * columns may be set, migration 018).
 */
export function distributionScopeOf(
  group: Pick<Group, 'distributionWorkspaceId' | 'distributionChannelId'> | null | undefined
): DistributionScope | null {
  if (group?.distributionWorkspaceId)
    return { kind: 'workspace', id: group.distributionWorkspaceId };
  if (group?.distributionChannelId) return { kind: 'channel', id: group.distributionChannelId };
  return null;
}

/**
 * Whether `userId` may hold a device in the key-distribution group of `scope` - asked of
 * social-service, which owns that roster (WP-KEYGROUP-JOIN-GATE).
 *
 * An ANSWER is `true` or `false`. Anything else - the secret unset, the service unreachable, a
 * non-2xx, a body without a boolean - is not an answer, so it throws a retryable 503 and never
 * resolves: a gate that cannot ask must not accept, and must not tell a legitimate joiner they are
 * refused either. The client's external join reads any failed submission as `unreachable`, claims
 * nothing about membership, and joins again on its next recovery pass.
 */
export async function isEntitledToDistributionGroup(
  scope: DistributionScope,
  userId: string,
  traceId: string
): Promise<boolean> {
  const what = `[ENTITLEMENT][${traceId}] UNANSWERED ${scope.kind}=${scope.id} user=${userId.slice(0, 8)}`;
  const entitled = await askSocial(
    'internal/distribution-groups/entitlement',
    { kind: scope.kind, scopeId: scope.id, userId },
    'entitled',
    what
  );
  if (typeof entitled !== 'boolean') return unanswered(what, 'no boolean in the answer');
  return entitled;
}

/** The prefix a salon's conversation id carries on the client (`channel_<channelId>`). */
const SALON_CONVERSATION_PREFIX = 'channel_';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The salon a client's conversation id names - `channel_<uuid>`, the key a salon's reaction push
 * carries as its `groupId` - or `null` for any other id. A prefix followed by anything but a uuid
 * names no salon, and is `null` too: the caller then reads it as the group id it is not.
 */
export function salonIdOf(conversationId: string): string | null {
  if (!conversationId.startsWith(SALON_CONVERSATION_PREFIX)) return null;
  const id = conversationId.slice(SALON_CONVERSATION_PREFIX.length);
  return UUID_RE.test(id) ? id : null;
}

/**
 * Whether `userId` may READ the salon `channelId` - a public salon's community member, a private
 * salon's reader - asked of social-service, which owns that roster. The salon half of the gate on
 * `mls/notify-reaction`: a salon is no group of this service, so no seat here can answer for it.
 *
 * An ANSWER is `true` or `false`; anything else throws the retryable 503, like the entitlement.
 */
export async function isSalonReader(
  channelId: string,
  userId: string,
  traceId: string
): Promise<boolean> {
  const what = `[SALON_READER][${traceId}] UNANSWERED channel=${channelId} user=${userId.slice(0, 8)}`;
  const reader = await askSocial(
    `internal/channels/${encodeURIComponent(channelId)}/reader`,
    { userId },
    'reader',
    what
  );
  if (typeof reader !== 'boolean') return unanswered(what, 'no boolean in the answer');
  return reader;
}

/** How a key group's departure ended, as social-service decided it once and for all. */
export type DepartureOutcome = 'departed' | 'cancelled';

/**
 * The outcome of the key-group departure `departure` of `userId` from `groupId` - asked of
 * social-service by the hourly drain, for a departure whose second eviction never arrived.
 *
 * NOT THE ENTITLEMENT, WHICH CANNOT ANSWER THIS. While the departure's roster write has not
 * committed, the entitlement still says `true` - and so it does after a rejoin. Social-service
 * records each departure by this name in the transaction of its roster write, and this question
 * DECIDES one still undecided: it records it `cancelled`, so the roster write can no longer commit
 * under that name (`departed` and `cancelled` share one key). The answer is therefore final.
 *
 * Anything but one of the two outcomes is not an answer and throws a 503, like the entitlement.
 */
export async function askDepartureOutcome(
  groupId: string,
  userId: string,
  departure: number,
  traceId: string
): Promise<DepartureOutcome> {
  const what = `[DEPARTURE][${traceId}] UNANSWERED group=${groupId} user=${userId.slice(0, 8)} departure=${departure}`;
  const outcome = await askSocial(
    'internal/distribution-groups/departure-outcome',
    { groupId, userId, departure },
    'outcome',
    what
  );
  if (outcome !== 'departed' && outcome !== 'cancelled') {
    return unanswered(what, 'no outcome in the answer');
  }
  return outcome;
}

/** Logs `what` with `why` and throws the retryable 503 every unanswered question here is. */
function unanswered(what: string, why: string): never {
  logger.warn(`${what}: ${why}`);
  throw new ServiceUnavailableException({
    error: 'entitlement_unavailable',
    message: 'membership could not be checked, retry',
  });
}

/**
 * POSTs `body` to social-service's internal `path` and returns the answer's `field`, unchecked.
 * The secret unset, the service unreachable, a non-2xx or an unreadable body throw
 * ({@link unanswered}); the caller checks the field's type.
 */
async function askSocial(
  path: string,
  body: Record<string, unknown>,
  field: string,
  what: string
): Promise<unknown> {
  const secret = process.env.INTERNAL_SECRET ?? '';
  if (!secret) return unanswered(what, 'INTERNAL_SECRET unset');
  let res: globalThis.Response;
  try {
    res = await fetch(socialUrl(path), {
      method: 'POST',
      headers: { 'x-internal-secret': secret, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (e) {
    return unanswered(
      what,
      `unreachable ${e instanceof Error ? `${e.name} ${e.message}` : String(e)}`
    );
  }
  if (!res.ok) return unanswered(what, `status=${res.status}`);
  try {
    return ((await res.json()) as Record<string, unknown>)[field];
  } catch (e) {
    return unanswered(what, `unreadable body ${e instanceof Error ? e.message : String(e)}`);
  }
}
