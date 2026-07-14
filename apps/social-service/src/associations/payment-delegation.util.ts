import type { Association } from './entities/association.entity';

/**
 * Where an association's online payments (paid forms + boutique) actually route, after honoring
 * an APPROVED parent-payment delegation. When an association delegates to an approved parent, the
 * parent's Stripe Connect account both receives the funds and defines whether payments can be
 * taken at all; otherwise the association's own account is used.
 */
export interface PaymentTarget {
  /** Association whose Stripe Connect account funds land in (this association, or its parent). */
  targetAssociationId: string;
  /** Stripe connected-account ID to route the destination charge to. Null when none is linked. */
  stripeAccountId: string | null;
  /** True when the resolved target has completed onboarding AND has a linked account. */
  ready: boolean;
  /** True when routing is delegated to a parent rather than served by the association itself. */
  delegated: boolean;
}

/** True when this association has an approved, active delegation to a parent's Stripe account. */
export function isDelegating(
  asso: Pick<Association, 'paymentDelegationStatus' | 'paymentParentAssociationId'>
): boolean {
  return asso.paymentDelegationStatus === 'approved' && !!asso.paymentParentAssociationId;
}

/**
 * Resolves the Stripe target for an association. When it delegates (approved) to a parent, pass
 * the loaded `parent` so the parent's account/readiness is used; otherwise pass null and the
 * association's own account is returned. A delegating association with a missing/unloaded parent
 * resolves to not-ready (routing must not silently fall back to the club's own account).
 */
export function resolvePaymentTarget(asso: Association, parent: Association | null): PaymentTarget {
  if (isDelegating(asso)) {
    if (!parent) {
      // Delegation is approved but the parent could not be loaded (deleted?) - fail closed.
      return {
        targetAssociationId: asso.paymentParentAssociationId,
        stripeAccountId: null,
        ready: false,
        delegated: true,
      };
    }
    return {
      targetAssociationId: parent.id,
      stripeAccountId: parent.stripeAccountId,
      ready: !!parent.stripeOnboardingComplete && !!parent.stripeAccountId,
      delegated: true,
    };
  }
  return {
    targetAssociationId: asso.id,
    stripeAccountId: asso.stripeAccountId,
    ready: !!asso.stripeOnboardingComplete && !!asso.stripeAccountId,
    delegated: false,
  };
}
