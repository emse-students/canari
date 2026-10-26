<script lang="ts">
  import type { AssociationProduct } from '$lib/associations/api';
  import CardTile from '$lib/components/shared/CardTile.svelte';
  import AmountPicker from '$lib/components/shop/AmountPicker.svelte';
  import ProductPrice from '$lib/components/shop/ProductPrice.svelte';
  import ProductPurchaseButton from '$lib/components/shop/ProductPurchaseButton.svelte';
  import { gridPriceIsProvisional, gridRefuses } from '$lib/pricing/viewerPrice';
  import { productDisplayName } from '$lib/shop/productCards';
  import { productFallbackIcon } from '$lib/utils/cardIcons';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** A product that is NOT a membership tier (tiers share one `MembershipCard`). */
    product: AssociationProduct;
    accentColor?: string | null;
    /** Free amount chosen in the keypad, in cents; bound so the page can read it. */
    customAmountCents?: number;
    signedIn?: boolean;
  }

  let {
    product,
    accentColor = null,
    customAmountCents = $bindable(),
    signedIn = true,
  }: Props = $props();

  const freeAmount = $derived(product.allowCustomAmount && product.amountCents === null);
  /**
   * Members-only is gated only where the listing knows the viewer's standing (`viewerIsCotisant`
   * is set by the shop listing alone); on a listing that does not say, the server decides.
   */
  const membersBlocked = $derived(product.membersOnly && product.viewerIsCotisant === false);
  const refused = $derived(gridRefuses(product));
</script>

<CardTile
  iconUrl={product.iconUrl}
  fallbackIcon={productFallbackIcon(product.type)}
  {accentColor}
  badgeText={product.badgeText}
>
  <div class="flex h-full flex-col gap-3 p-5" data-product-card={product.type}>
    <div class="min-w-0">
      <p class="text-text-main text-base font-semibold">{productDisplayName(product)}</p>
      {#if product.description}
        <p class="text-text-muted mt-1 line-clamp-2 text-xs">{product.description}</p>
      {/if}
    </div>

    {#if !freeAmount}
      <ProductPrice {product} />
    {:else}
      <AmountPicker
        bind:valueCents={customAmountCents}
        minCents={product.customAmountMinCents}
        currency={product.currency}
      />
    {/if}

    <div class="mt-auto space-y-2">
      <ProductPurchaseButton
        {product}
        {customAmountCents}
        disabled={membersBlocked || refused}
        class="w-full"
      />
      {#if refused}
        <p class="text-xs text-amber-700 dark:text-amber-400">{m.shop_price_unavailable_hint()}</p>
      {:else if gridPriceIsProvisional(product, signedIn)}
        <p class="text-text-muted text-xs">{m.shop_price_profile_hint()}</p>
      {/if}
      {#if membersBlocked}
        <p class="text-xs text-amber-700 dark:text-amber-400">{m.shop_members_only_hint()}</p>
      {/if}
    </div>
  </div>
</CardTile>
