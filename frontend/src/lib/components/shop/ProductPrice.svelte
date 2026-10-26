<script lang="ts">
  import type { AssociationProduct } from '$lib/associations/api';
  import { customAmountLabel } from '$lib/associations/customAmountLabel';
  import { gridPriceLabel } from '$lib/pricing/viewerPrice';
  import { formatMoney } from '$lib/shop/money';
  import { dueCents, struckCents } from '$lib/shop/productCards';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    product: AssociationProduct;
    /** Larger figure for a card's headline price; the compact size serves a tier row. */
    size?: 'headline' | 'row';
  }

  let { product, size = 'headline' }: Props = $props();

  const due = $derived(dueCents(product));
  const struck = $derived(struckCents(product));
  /** Wording for a product with no fixed figure: refused grid cell, free amount, or free. */
  const wording = $derived(
    gridPriceLabel(product) ??
      (product.allowCustomAmount && product.amountCents === null
        ? customAmountLabel(product)
        : m.shop_price_free())
  );
</script>

<p class="flex flex-wrap items-baseline gap-x-2" data-product-price>
  {#if due !== null && due > 0}
    <span
      class="text-text-main font-bold tabular-nums {size === 'headline' ? 'text-lg' : 'text-base'}"
      data-due>{formatMoney(due, product.currency)}</span
    >
    {#if struck !== null}
      <span class="text-text-muted text-xs tabular-nums line-through" data-struck
        >{formatMoney(struck, product.currency)}</span
      >
    {/if}
  {:else}
    <span class="text-text-main text-sm font-semibold">{wording}</span>
  {/if}
</p>
