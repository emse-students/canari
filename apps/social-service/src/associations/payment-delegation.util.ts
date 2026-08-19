import type { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import type { Association } from './entities/association.entity';

/** Mirrors core-service's PaymentProviderId - no shared lib crosses this service boundary. */
export type PaymentProviderId = 'stripe' | 'lydia';

/**
 * Where an association's online payments (paid forms + boutique) actually route, after honoring
 * an APPROVED parent-payment delegation. When an association delegates to an approved parent, the
 * parent's account both receives the funds and defines whether payments can be taken at all;
 * otherwise the association's own account is used. Resolved against ONE provider at a time - the
 * platform's currently active one - since Stripe and Lydia each keep their own account id and
 * onboarding flag on `Association` and are never both "the" destination simultaneously.
 */
export interface PaymentTarget {
  /** Association whose account funds land in (this association, or its parent). */
  targetAssociationId: string;
  /** Which provider this target was resolved against. */
  provider: PaymentProviderId;
  /** Connect-style account id for that provider (Stripe `acct_...` or Lydia `vendor_token`). Null when none linked. */
  connectAccountId: string | null;
  /** True when the resolved target has completed onboarding AND has a linked account, for `provider`. */
  ready: boolean;
  /** True when routing is delegated to a parent rather than served by the association itself. */
  delegated: boolean;
}

/** True when this association has an approved, active delegation to a parent's account. */
export function isDelegating(
  asso: Pick<Association, 'paymentDelegationStatus' | 'paymentParentAssociationId'>
): boolean {
  return asso.paymentDelegationStatus === 'approved' && !!asso.paymentParentAssociationId;
}

/** Reads the account id + onboarding flag for one provider off an association row. */
function accountFor(
  asso: Pick<
    Association,
    'stripeAccountId' | 'stripeOnboardingComplete' | 'lydiaAccountId' | 'lydiaOnboardingComplete'
  >,
  provider: PaymentProviderId
): { accountId: string | null; complete: boolean } {
  return provider === 'lydia'
    ? { accountId: asso.lydiaAccountId, complete: asso.lydiaOnboardingComplete }
    : { accountId: asso.stripeAccountId, complete: asso.stripeOnboardingComplete };
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
  if (isDelegating(asso)) {
    if (!parent) {
      // Delegation is approved but the parent could not be loaded (deleted?) - fail closed.
      return {
        targetAssociationId: asso.paymentParentAssociationId,
        provider,
        connectAccountId: null,
        ready: false,
        delegated: true,
      };
    }
    const { accountId, complete } = accountFor(parent, provider);
    return {
      targetAssociationId: parent.id,
      provider,
      connectAccountId: accountId,
      ready: !!complete && !!accountId,
      delegated: true,
    };
  }
  const { accountId, complete } = accountFor(asso, provider);
  return {
    targetAssociationId: asso.id,
    provider,
    connectAccountId: accountId,
    ready: !!complete && !!accountId,
    delegated: false,
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
  httpService: HttpService,
  paymentBase: string
): Promise<PaymentProviderId> {
  const { data } = await firstValueFrom(
    httpService.get<{ provider: PaymentProviderId }>(`${paymentBase}/api/payments/provider`)
  );
  return data.provider === 'lydia' ? 'lydia' : 'stripe';
}
