<script lang="ts">
  import type { AssociationProduct } from '$lib/associations/api';
  import CardTile from '$lib/components/shared/CardTile.svelte';
  import AmountPicker from '$lib/components/shop/AmountPicker.svelte';
  import ProductPrice from '$lib/components/shop/ProductPrice.svelte';
  import ProductPurchaseButton from '$lib/components/shop/ProductPurchaseButton.svelte';
  import { gridPriceIsProvisional, gridRefuses } from '$lib/pricing/viewerPrice';
  import { productDisplayName } from '$lib/shop/productCards';
  import { productFallbackIcon } from '$lib/utils/cardIcons';
  import { TriangleAlert } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** A product that is NOT a membership tier (tiers share one `MembershipCard`). */
    product: AssociationProduct;
    accentColor?: string | null;
    /** Free amount chosen in the keypad, in cents; bound so the page can read it. */
    customAmountCents?: number;
    signedIn?: boolean;
    /** The product's siblings (same association), for `ProductPrice`'s "for holders of X". */
    siblings?: readonly AssociationProduct[];
  }

  let {
    product,
    accentColor = null,
    customAmountCents = $bindable(),
    signedIn = true,
    siblings = [],
  }: Props = $props();

  const freeAmount = $derived(product.allowCustomAmount && product.amountCents === null);
  /**
   * `viewerIsCotisant` is annotated by both listing endpoints (`listAllProducts`,
   * `listAssociationProducts`) and is never genuinely ambiguous for a signed-in viewer there - but
   * the type is optional, and an `undefined` MUST read as "not confirmed a member", never as "not
   * confirmed NOT a member": `=== false` let a not-yet-annotated viewer see a live button a
   * members-only product would refuse.
   */
  const membersBlocked = $derived(product.membersOnly && !product.viewerIsCotisant);
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
      <div class="flex items-center justify-between gap-2">
        <p class="text-text-main text-base font-semibold">{productDisplayName(product)}</p>
        {#if product.membersOnly}
          <span
            class="bg-accent/20 text-accent-text rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap"
          >
            {m.shop_members_only_badge()}
          </span>
        {/if}
      </div>
      {#if product.description}
        <p class="text-text-muted mt-1 line-clamp-2 text-xs">{product.description}</p>
      {/if}
    </div>

    {#if !freeAmount}
      <ProductPrice {product} {siblings} />
    {:else}
      <AmountPicker
        bind:valueCents={customAmountCents}
        minCents={product.customAmountMinCents}
        maxCents={product.customAmountMaxCents}
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
        <p class="text-amber-warn-text flex items-start gap-1 text-xs">
          <TriangleAlert size={12} class="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{m.shop_price_unavailable_hint()}</span>
        </p>
      {:else if gridPriceIsProvisional(product, signedIn)}
        <p class="text-text-muted text-xs">{m.shop_price_profile_hint()}</p>
      {/if}
      {#if membersBlocked}
        <p class="text-amber-warn-text text-xs">{m.shop_members_only_hint()}</p>
      {/if}
    </div>
  </div>
</CardTile>
