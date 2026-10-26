<script lang="ts">
  import type { AssociationProduct } from '$lib/associations/api';
  import CardTile from '$lib/components/shared/CardTile.svelte';
  import ProductPrice from '$lib/components/shop/ProductPrice.svelte';
  import ProductPurchaseButton from '$lib/components/shop/ProductPurchaseButton.svelte';
  import { gridRefuses } from '$lib/pricing/viewerPrice';
  import { productDisplayName, struckCents } from '$lib/shop/productCards';
  import { productFallbackIcon } from '$lib/utils/cardIcons';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The tiers this viewer may buy (`offeredTiers`): never empty, the caller omits the card. */
    tiers: AssociationProduct[];
    accentColor?: string | null;
  }

  let { tiers, accentColor = null }: Props = $props();

  /** True when at least one row shows a reduced amount, so the hint explaining it is worth a line. */
  const hasRise = $derived(tiers.some((t) => struckCents(t) !== null));
</script>

<CardTile fallbackIcon={productFallbackIcon('membership')} {accentColor}>
  <div class="flex h-full flex-col gap-3 p-5" data-membership-card>
    <p class="text-text-main text-base font-semibold">{m.shop_membership_card_title()}</p>
    <ul class="divide-cn-border divide-y">
      {#each tiers as tier (tier.id)}
        <li class="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0" data-tier-row>
          <div class="min-w-0">
            <p class="text-text-main truncate text-sm font-medium">{productDisplayName(tier)}</p>
            <ProductPrice product={tier} size="row" />
          </div>
          <ProductPurchaseButton product={tier} disabled={gridRefuses(tier)} class="shrink-0" />
        </li>
      {/each}
    </ul>
    {#if hasRise}
      <p class="text-text-muted text-xs">{m.shop_membership_rise_hint()}</p>
    {/if}
  </div>
</CardTile>
