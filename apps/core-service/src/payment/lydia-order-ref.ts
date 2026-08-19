const UUID_RE_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * What an `order_ref` Canari itself generated for a Lydia `request/do` call identifies - see
 * `products.service.ts`/`forms.service.ts` in social-service, the only writers of this format.
 */
export type LydiaOrderRef =
  | { kind: 'form'; submissionId: string }
  | { kind: 'product'; productId: string; userId: string };

/**
 * Parses Canari's own `order_ref` encoding back into what it identifies. Returns null for
 * anything that doesn't match exactly - a malformed or foreign `order_ref` must never be guessed
 * at, since it drives which submission/purchase gets marked paid.
 */
export function parseLydiaOrderRef(orderRef: string | null | undefined): LydiaOrderRef | null {
  if (!orderRef) return null;
  const formMatch = new RegExp(`^form:([a-zA-Z0-9_-]{1,128})$`).exec(orderRef);
  if (formMatch) return { kind: 'form', submissionId: formMatch[1] };
  const productMatch = new RegExp(`^product:(${UUID_RE_PART}):(${UUID_RE_PART})$`, 'i').exec(
    orderRef
  );
  if (productMatch) return { kind: 'product', productId: productMatch[1], userId: productMatch[2] };
  return null;
}

/**
 * Builds the metadata dict `retrieveSession()` exposes generically, from a parsed `order_ref` -
 * mirrors Stripe's checkout session metadata shape so `verify-session`/`cancel-session` in
 * `payment.controller.ts` need no provider-specific branch.
 */
export function orderRefToMetadata(ref: LydiaOrderRef | null): Record<string, string> {
  if (!ref) return {};
  return ref.kind === 'form'
    ? { submissionId: ref.submissionId }
    : { productId: ref.productId, userId: ref.userId };
}
