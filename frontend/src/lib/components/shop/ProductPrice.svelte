<script lang="ts">
  import type { AssociationProduct } from '$lib/associations/api';
  import {
    fullPriceLabel,
    gridRefuses,
    linkedTierName,
    preferentialPriceLabel,
  } from '$lib/pricing/viewerPrice';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    product: AssociationProduct;
    /** Larger figure for a non-tier card's headline price; the compact size serves a tier row. */
    size?: 'headline' | 'row';
    /** The product's siblings (same association), for `linkedTierName`'s "for holders of X". */
    siblings?: readonly AssociationProduct[];
  }

  let { product, size = 'headline', siblings = [] }: Props = $props();

  /**
   * The preferential amount the viewer pays, or null when they pay the full price (or the product
   * is gridded, free-amount, or has no fixed price at all) - `preferentialPriceLabel`, the server's
   * `viewerDueCents` read through the ONE canonical decision, never recomputed here.
   */
  const preferential = $derived(preferentialPriceLabel(product));
  const full = $derived(fullPriceLabel(product));
  /** A real figure (a fixed amount or a priced grid cell) reads big and bold; a wordy fallback
   * (free, custom, unavailable) does not, so it never looks like a price it is not. */
  const numeric = $derived(
    !gridRefuses(product) && (product.amountCents !== null || preferential !== null)
  );
  /** Why the reduced price applies: the linked sibling tier's name, or the plain cotisant wording. */
  const reasonText = $derived(() => {
    const tier = linkedTierName(product, siblings);
    return tier ? m.shop_tier_upgrade_price_suffix({ tier }) : m.shop_member_price_suffix();
  });
</script>

<p class="flex flex-wrap items-baseline gap-x-2" data-product-price>
  {#if numeric}
    <span
      class="text-text-main font-bold tabular-nums {size === 'headline' ? 'text-lg' : 'text-base'}"
      data-due>{preferential ?? full}</span
    >
    {#if preferential !== null}
      <span class="text-text-muted text-xs tabular-nums line-through" data-struck>{full}</span>
      <span class="text-text-muted block text-xs" data-preferential-reason>{reasonText()}</span>
    {/if}
  {:else}
    <span class="text-text-main text-sm font-semibold">{full}</span>
  {/if}
</p>
