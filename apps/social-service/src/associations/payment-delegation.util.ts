import { Logger } from '@nestjs/common';
import type { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import type { EntityManager } from 'typeorm';
import { Association as AssociationEntity, type Association } from './entities/association.entity';
import type { LydiaReadinessCause } from './lydia-readiness';
import { AssociationPermissionFlag, typeExcludedFlags } from './entities/association-member.entity';
import { coreUrl } from '../internal/service-urls';

/** Mirrors core-service's PaymentProviderId - no shared lib crosses this service boundary. */
export type PaymentProviderId = 'lydia' | 'disabled';

/** The message every refusal carries when the platform declares payments disabled. */
export const PAYMENTS_DISABLED_MESSAGE = 'Payments are disabled on this platform';

const logger = new Logger('PaymentDelegation');

/**
 * Where an association's online payments (paid forms + boutique) actually route, after honoring
 * an APPROVED parent-payment delegation. When an association delegates to an approved parent, the
 * parent's account both receives the funds and defines whether payments can be taken at all;
 * otherwise the association's own account is used. A platform that declares payments `disabled`
 * resolves to NOT ready with no account id, delegated or not (fail closed). Resolved against the platform's active
 * provider (Lydia, or `disabled`); the `stripe*` columns on `Association` are historic and never read.
 */
export interface PaymentTarget {
  /** Association whose account funds land in (this association, or its parent). */
  targetAssociationId: string;
  /** Which provider this target was resolved against. */
  provider: PaymentProviderId;
  /** Connect-style account id for that provider (the Lydia `vendor_token`). Null when none linked. */
  connectAccountId: string | null;
  /** True when the resolved target has completed onboarding AND has a linked account, for `provider`. */
  ready: boolean;
  /** True when routing is delegated to a parent rather than served by the association itself. */
  delegated: boolean;
  /**
   * The target's last readiness cause (migration 118), so a refusal says WHY it is not ready
   * (`paymentsNotReady`): blocked by Lydia, or not activated. Null when none was ever written.
   */
  readinessCause: LydiaReadinessCause | null;
}

/** True when this association has an approved, active delegation to a parent's account. */
export function isDelegating(
  asso: Pick<Association, 'paymentDelegationStatus' | 'paymentParentAssociationId'>
): boolean {
  return asso.paymentDelegationStatus === 'approved' && !!asso.paymentParentAssociationId;
}

/**
 * Whether an entity of this kind may hold a Lydia account of its own: the kind table
 * (`TYPE_EXCLUDED_FLAGS`) does not exclude `MANAGE_PAYOUT_ACCOUNT` for it. An association does; a
 * list and an institution do not. A row with no kind loaded reads as an association, the column's
 * default.
 */
export function holdsOwnAccount(type: Association['type'] | undefined): boolean {
  return (
    (typeExcludedFlags(type ?? 'association') & AssociationPermissionFlag.MANAGE_PAYOUT_ACCOUNT) ===
    0
  );
}

/** Reads the Lydia account id, onboarding flag and readiness cause off an association row. */
function accountFor(
  asso: Pick<Association, 'lydiaAccountId' | 'lydiaOnboardingComplete' | 'lydiaReadinessCause'>
): {
  accountId: string | null;
  complete: boolean;
  cause: LydiaReadinessCause | null;
} {
  return {
    accountId: asso.lydiaAccountId,
    complete: asso.lydiaOnboardingComplete,
    cause: asso.lydiaReadinessCause ?? null,
  };
}

/**
 * THE DELEGATE PREDICATE: the associations whose payments `parentId`'s Business serves - an
 * APPROVED delegation to it, nothing else (a pending request, or one revoked meanwhile, is not).
 * The ONE definition the readiness writer (`AssociationsService.setLydiaReadiness`) withholds AND
 * releases with, in the same transaction as the readiness, and the unlink withholds with
 * (`clearLydiaAccount`), so the two are exact inverses. Reads through `manager`, inside the
 * caller's transaction.
 *
 * The delegate rows are SHARE-locked (`FOR SHARE`, in id order): a revoke, a cancel or a move locks
 * the child FOR UPDATE, so it either commits before this read - and the child is no longer read as a
 * delegate - or waits for the caller's commit, after which it withholds what was released. Without
 * the lock a revoke committing between this read and the release re-opened a paused list's
 * products for good (owner review of #2967). Every caller holds the PARENT's lock first, as the
 * approval does (parent FOR SHARE, then child FOR UPDATE), so the order is the same everywhere.
 */
export async function approvedDelegateIds(
  manager: Pick<EntityManager, 'find'>,
  parentId: string
): Promise<string[]> {
  const children = await manager.find(AssociationEntity, {
    where: { paymentParentAssociationId: parentId, paymentDelegationStatus: 'approved' },
    select: { id: true },
    order: { id: 'ASC' },
    lock: { mode: 'pessimistic_read' },
  });
  return children.map((c) => c.id);
}

/**
 * The purchase records of `childId` that the Business `vendorToken` TOOK: a boutique payment
 * through its paid checkout, a form payment through its answer. The fact that decides who owns a
 * delegate's payment once the delegation has ended - the account that holds the money, never the
 * delegation's current state (owner review of #2967, 2026-11-03).
 */
export async function purchaseIdsTakenBy(
  manager: Pick<EntityManager, 'query'>,
  childId: string,
  vendorToken: string
): Promise<string[]> {
  const rows = (await manager.query(
    `SELECT pr.id FROM purchase_records pr
      WHERE pr."associationId" = $1
        AND (EXISTS (SELECT 1 FROM product_checkouts c
                      WHERE c."purchaseRecordId" = pr.id AND c.status = 'paid'
                        AND c."vendorToken" = $2)
             OR EXISTS (SELECT 1 FROM submissions s
                         WHERE s.id = pr."submissionId" AND s."lydiaVendorToken" = $2))`,
    [childId, vendorToken]
  )) as { id: string }[];
  return rows.map((r) => r.id);
}

/** Counts the `associationId` of each row an `UPDATE ... RETURNING "associationId"` touched. */
function countByAssociation(result: unknown): Map<string, number> {
  // node-postgres answers an UPDATE ... RETURNING through TypeORM as [rows, count].
  const rows = (
    Array.isArray(result) && Array.isArray(result[0]) ? result[0] : (result as unknown[])
  ) as { associationId: string }[];
  const out = new Map<string, number>();
  for (const row of rows) out.set(row.associationId, (out.get(row.associationId) ?? 0) + 1);
  return out;
}

/**
 * WITHHOLDS the on-sale products of `associationIds` - `isActive=false, activationWithheld=true`,
 * the exact inverse of {@link releaseWithheldProductsOf} - inside the caller's transaction, and says
 * how many per entity, so a notice goes only to an entity something was actually withheld from. A
 * product a manager had taken off sale is not touched, so it is never released later either.
 */
export async function withholdOnSaleProductsOf(
  manager: Pick<EntityManager, 'query'>,
  associationIds: readonly string[]
): Promise<Map<string, number>> {
  if (associationIds.length === 0) return new Map();
  return countByAssociation(
    await manager.query(
      `UPDATE association_products SET "isActive" = false, "activationWithheld" = true
        WHERE "associationId" = ANY($1::uuid[]) AND "isActive" = true
        RETURNING "associationId"`,
      [[...associationIds]]
    )
  );
}

/**
 * RELEASES the withheld products of `associationIds` back on sale, inside the caller's transaction
 * - the one that made them able to collect (an acceptance, a receiver ready again), so a commit
 * never leaves them withheld. The caller has proven, under its locks, that each of them collects
 * now. Says how many per entity, for the notice.
 */
export async function releaseWithheldProductsOf(
  manager: Pick<EntityManager, 'query'>,
  associationIds: readonly string[]
): Promise<Map<string, number>> {
  if (associationIds.length === 0) return new Map();
  return countByAssociation(
    await manager.query(
      `UPDATE association_products SET "isActive" = true, "activationWithheld" = false
        WHERE "associationId" = ANY($1::uuid[]) AND "activationWithheld" = true
        RETURNING "associationId"`,
      [[...associationIds]]
    )
  );
}

/**
 * Whether `asso` collects on Lydia: through `parent` when it delegates (approved), on its own
 * account otherwise - the same answer `resolvePaymentTarget` gives, read on rows a caller holds.
 * What a delegation notice is decided by, before and after a change (owner review of #2967): a
 * list with paid forms only stops collecting like one with products.
 */
export function collectsThrough(asso: Association, parent: Association | null): boolean {
  return resolvePaymentTarget(asso, parent, 'lydia').ready;
}

/**
 * Resolves the payment target for an association, against the given (already-resolved) active
 * provider. When it delegates (approved) to a parent, pass the loaded `parent` so the parent's
 * account/readiness is used; otherwise pass null and the association's own account is returned. A
 * delegating association with a missing/unloaded parent resolves to not-ready (routing must not
 * silently fall back to the club's own account).
 */
export function resolvePaymentTarget(
  asso: Association,
  parent: Association | null,
  provider: PaymentProviderId
): PaymentTarget {
  if (provider === 'disabled') {
    logger.warn(
      `resolvePaymentTarget: payments are disabled platform-wide, association ${asso.id} is not ready`
    );
    const delegated = isDelegating(asso);
    return {
      targetAssociationId: delegated ? asso.paymentParentAssociationId : asso.id,
      provider,
      connectAccountId: null,
      ready: false,
      delegated,
      readinessCause: null,
    };
  }
  if (isDelegating(asso)) {
    if (!parent) {
      // Delegation is approved but the parent could not be loaded (deleted?) - fail closed.
      return {
        targetAssociationId: asso.paymentParentAssociationId,
        provider,
        connectAccountId: null,
        ready: false,
        delegated: true,
        readinessCause: null,
      };
    }
    const { accountId, complete, cause } = accountFor(parent);
    return {
      targetAssociationId: parent.id,
      provider,
      connectAccountId: accountId,
      ready: !!complete && !!accountId,
      delegated: true,
      readinessCause: cause,
    };
  }
  if (!holdsOwnAccount(asso.type)) {
    // A LIST holds no Lydia account of its own and collects ONLY through an approved delegation
    // (owner, 2026-11-02): not delegating, it is not ready, whatever `lydiaAccountId` a row from
    // before that decision still carries. The withheld-product release reads this same answer.
    logger.debug(
      `resolvePaymentTarget: ${asso.type} ${asso.id} holds no account of its own and does not ` +
        'delegate - not ready'
    );
    return {
      targetAssociationId: asso.id,
      provider,
      connectAccountId: null,
      ready: false,
      delegated: false,
      readinessCause: null,
    };
  }
  const { accountId, complete, cause } = accountFor(asso);
  return {
    targetAssociationId: asso.id,
    provider,
    connectAccountId: accountId,
    ready: !!complete && !!accountId,
    delegated: false,
    readinessCause: cause,
  };
}

/**
 * Fetches the platform's currently active payment provider from core-service - the same public,
 * unauthenticated endpoint the frontend polls to choose which onboarding UI to render. Callers
 * MUST let a failure here propagate rather than defaulting to a guess: which provider is active is
 * a money-routing decision, and guessing wrong risks resolving `ready`/`connectAccountId` against
 * the wrong pair of columns.
 */
export async function fetchActivePaymentProvider(
  httpService: HttpService
): Promise<PaymentProviderId> {
  const { data } = await firstValueFrom(
    httpService.get<{ provider: PaymentProviderId }>(coreUrl('payments/provider'))
  );
  // The REAL value: mapping an unknown answer to 'lydia' would route a disabled platform to
  // Lydia. A value this service does not know (the retired 'stripe' included) is an error, never a
  // guess.
  if (data.provider === 'lydia' || data.provider === 'disabled') {
    return data.provider;
  }
  logger.error(`fetchActivePaymentProvider: unknown provider ${JSON.stringify(data.provider)}`);
  throw new Error(`core-service returned an unknown payment provider: ${String(data.provider)}`);
}
