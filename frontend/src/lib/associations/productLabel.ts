/**
 * The name an admin screen shows for a product or a purchase line. A Cercle top-up is a product a
 * global admin creates once, and its stored name can be the technical type itself
 * (`balance_topup` was reported on an admin screen, 2026-10-26), so its label comes from its TYPE in the reader's language, never from
 * the stored name.
 */
import { m } from '$lib/paraglide/messages';
import type { AssociationProduct, AssociationPurchase } from './api';

/** A product's display name: localized by type for a Cercle top-up, its own name otherwise. */
export function productLabel(product: Pick<AssociationProduct, 'type' | 'name'>): string {
  return product.type === 'balance_topup' ? m.admin_cercle_product_name() : product.name;
}

/**
 * A purchase line's item name. The line carries a snapshot of the product name taken at payment;
 * when its product still exists, the product's type decides (a top-up reads as one), otherwise the
 * snapshot is all there is.
 */
export function purchaseItemLabel(
  purchase: Pick<AssociationPurchase, 'productId' | 'productName'>,
  productsById: ReadonlyMap<string, Pick<AssociationProduct, 'type' | 'name'>>
): string {
  const product = purchase.productId ? productsById.get(purchase.productId) : undefined;
  return product?.type === 'balance_topup' ? productLabel(product) : purchase.productName;
}
