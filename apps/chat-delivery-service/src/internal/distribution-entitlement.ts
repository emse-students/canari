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
  const secret = process.env.INTERNAL_SECRET ?? '';
  const unavailable = (why: string): never => {
    logger.warn(
      `[ENTITLEMENT][${traceId}] UNANSWERED ${scope.kind}=${scope.id} user=${userId.slice(0, 8)}: ${why}`
    );
    throw new ServiceUnavailableException({
      error: 'entitlement_unavailable',
      message: 'membership could not be checked, retry',
    });
  };
  if (!secret) return unavailable('INTERNAL_SECRET unset');
  let res: globalThis.Response;
  try {
    res = await fetch(socialUrl('internal/distribution-groups/entitlement'), {
      method: 'POST',
      headers: { 'x-internal-secret': secret, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: scope.kind, scopeId: scope.id, userId }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (e) {
    return unavailable(`unreachable ${e instanceof Error ? `${e.name} ${e.message}` : String(e)}`);
  }
  if (!res.ok) return unavailable(`status=${res.status}`);
  let entitled: unknown;
  try {
    entitled = ((await res.json()) as { entitled?: unknown }).entitled;
  } catch (e) {
    return unavailable(`unreadable body ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof entitled !== 'boolean') return unavailable('no boolean in the answer');
  return entitled;
}
