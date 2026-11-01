import { Logger } from '@nestjs/common';
import type { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import type { EntityManager } from 'typeorm';
import { Association as AssociationEntity, type Association } from './entities/association.entity';
import type { LydiaReadinessCause } from './lydia-readiness';
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
 * The ONE definition shared by the release of withheld products
 * (`ProductsService.releaseWithheldForAssociationAndDelegates`) and the withhold of a readiness
 * revert (`AssociationsService.setLydiaReadiness`), so the two are exact inverses: a spec asserts
 * both call this function. Reads through `manager`, so a caller inside a transaction reads its own
 * snapshot.
 */
export async function approvedDelegateIds(
  manager: Pick<EntityManager, 'find'>,
  parentId: string
): Promise<string[]> {
  const children = await manager.find(AssociationEntity, {
    where: { paymentParentAssociationId: parentId, paymentDelegationStatus: 'approved' },
    select: { id: true },
  });
  return children.map((c) => c.id);
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
