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
    /** The tiers this viewer may buy (`offeredTiers`): never empty unless `cotisationDisabled`. */
    tiers: AssociationProduct[];
    /**
     * EVERY product of the association, `tiers` included - `linkedTierName` needs the full set, as
     * the sibling a preferential price is "for holders of" is typically the tier the viewer
     * HOLDS, which `offeredTiers` deliberately leaves out of `tiers`.
     */
    allProducts?: readonly AssociationProduct[];
    accentColor?: string | null;
    /** A tier cannot be ranked against the membership held: say why it has no row. */
    unrankedHint?: boolean;
    /**
     * The association's cotisations are disabled (`cotisationDisabledForAssociation`): every tier
     * row is refused anyway, so the card shows the reason instead of rows that would all read
     * "unavailable" - and instead of nothing, which would read exactly like holding the top tier.
     */
    cotisationDisabled?: boolean;
    signedIn?: boolean;
  }

  let {
    tiers,
    allProducts = tiers,
    accentColor = null,
    unrankedHint = false,
    cotisationDisabled = false,
    signedIn = true,
  }: Props = $props();

  /** Same rule as `ProductCard.svelte`'s `membersBlocked`: `offeredTiers` already excludes a tier
   * the viewer holds or ranks below, but a tier can ALSO be reserved to existing members
   * (`membersOnly`) independently of rank - a row `tierNotOffered` never refuses, so the button
   * must check it itself. */
  function membersBlocked(tier: AssociationProduct): boolean {
    return tier.membersOnly && !tier.viewerIsCotisant;
  }

  /** A tier sold at a free amount (no fixed price) is bought at the amount its row's picker holds. */
  function freeAmount(tier: AssociationProduct): boolean {
    return tier.allowCustomAmount && tier.amountCents === null;
  }

  /** The amount chosen in each free-amount tier row, by product id, in cents. */
  let customAmounts = $state<Record<string, number | undefined>>({});
</script>

<CardTile fallbackIcon={productFallbackIcon('membership')} {accentColor}>
  <div class="flex h-full flex-col gap-3 p-5" data-membership-card>
    <p class="text-text-main text-base font-semibold">{m.shop_membership_card_title()}</p>
    {#if cotisationDisabled}
      <p class="text-text-muted text-sm" data-cotisation-disabled>{m.shop_cotisation_disabled()}</p>
    {:else}
      <ul class="divide-cn-border divide-y">
        {#each tiers as tier (tier.id)}
          <li class="flex flex-col gap-3 py-3 first:pt-0 last:pb-0" data-tier-row>
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <p class="text-text-main truncate text-sm font-medium">
                  {productDisplayName(tier)}
                </p>
                <ProductPrice product={tier} size="row" siblings={allProducts} />
                {#if gridRefuses(tier)}
                  <p class="text-xs text-amber-700 dark:text-amber-400">
                    {m.shop_price_unavailable_hint()}
                  </p>
                {:else if gridPriceIsProvisional(tier, signedIn)}
                  <p class="text-text-muted text-xs">{m.shop_price_profile_hint()}</p>
                {/if}
                {#if membersBlocked(tier)}
                  <p class="text-xs text-amber-700 dark:text-amber-400">
                    {m.shop_members_only_hint()}
                  </p>
                {/if}
              </div>
              <ProductPurchaseButton
                product={tier}
                customAmountCents={freeAmount(tier) ? customAmounts[tier.id] : undefined}
                disabled={gridRefuses(tier) || membersBlocked(tier)}
                class="shrink-0"
              />
            </div>
            {#if freeAmount(tier)}
              <AmountPicker
                bind:valueCents={customAmounts[tier.id]}
                minCents={tier.customAmountMinCents}
                maxCents={tier.customAmountMaxCents}
                currency={tier.currency}
              />
            {/if}
          </li>
        {/each}
      </ul>
      {#if unrankedHint}
        <p class="text-text-muted text-xs" data-unranked-hint>{m.shop_tier_not_rankable()}</p>
      {/if}
    {/if}
  </div>
</CardTile>
