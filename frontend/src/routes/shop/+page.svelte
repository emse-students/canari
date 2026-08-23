<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { showToast } from '$lib/stores/toast.svelte';
  import {
    listAllProducts,
    listAssociations,
    listAllPartnerships,
    type AssociationProduct,
    type Association,
    type PartnershipCard,
  } from '$lib/associations/api';
  import { currentUserId } from '$lib/stores/user';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import ProductPurchaseButton from '$lib/components/shop/ProductPurchaseButton.svelte';
  import PartnershipCardList from '$lib/components/shop/PartnershipCardList.svelte';
  import CardTile from '$lib/components/shared/CardTile.svelte';
  import { productFallbackIcon } from '$lib/utils/cardIcons';
  import { generateAvatarColor } from '$lib/utils/avatar';
  import { ShoppingBag, Handshake } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  let products = $state<AssociationProduct[]>([]);
  let partnerships = $state<PartnershipCard[]>([]);
  let associations = new SvelteMap<string, Association>();
  let loading = $state(true);
  let error = $state('');
  let customAmounts = $state<Record<string, number>>({});
  let shopTab = $state<'products' | 'partnerships'>('products');

  const isLoggedIn = $derived(!!currentUserId());

  /** Orders membership tiers base-first then by ascending variantLevel; leaves other pairs untouched (stable sort). */
  function compareTiers(a: AssociationProduct, b: AssociationProduct): number {
    if (a.type === 'membership' && b.type === 'membership') {
      const rankA = a.variantKey === null ? -1 : (a.variantLevel ?? 0);
      const rankB = b.variantKey === null ? -1 : (b.variantLevel ?? 0);
      if (rankA !== rankB) return rankA - rankB;
    }
    return 0;
  }

  /** Products grouped by associationId, membership tiers sorted base-first. */
  const grouped = $derived.by(() => {
    const map = new SvelteMap<string, AssociationProduct[]>();
    for (const p of products) {
      const list = map.get(p.associationId) ?? [];
      list.push(p);
      map.set(p.associationId, list);
    }
    for (const [id, list] of map) {
      map.set(id, [...list].sort(compareTiers));
    }
    return map;
  });

  /** Partnership cards grouped by associationId, same shape as `grouped` for the products tab. */
  const partnershipsGrouped = $derived.by(() => {
    const map = new SvelteMap<string, PartnershipCard[]>();
    for (const p of partnerships) {
      const list = map.get(p.associationId) ?? [];
      list.push(p);
      map.set(p.associationId, list);
    }
    return map;
  });

  onMount(async () => {
    if (!isLoggedIn) {
      loading = false;
      return;
    }
    try {
      const [prods, assos, partners] = await Promise.all([
        listAllProducts(),
        listAssociations(),
        listAllPartnerships(),
      ]);
      products = prods;
      partnerships = partners;
      assos.forEach((a) => associations.set(a.id, a));
    } catch (err) {
      error = err instanceof Error ? err.message : m.shop_load_error_fallback();
    } finally {
      loading = false;
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get('purchase_success') === '1') {
      showToast(m.shop_purchase_success());
      history.replaceState(null, '', '/shop');
    } else if (params.get('purchase_cancel') === '1') {
      history.replaceState(null, '', '/shop');
    }
  });

  /** Returns a human-readable price label for a product. */
  function priceLabel(p: AssociationProduct): string {
    if (p.amountCents !== null) {
      return `${(p.amountCents / 100).toFixed(2)} ${p.currency.toUpperCase()}`;
    }
    if (p.allowCustomAmount) {
      const min = p.customAmountMinCents ? (p.customAmountMinCents / 100).toFixed(2) : '0';
      const max = p.customAmountMaxCents ? (p.customAmountMaxCents / 100).toFixed(2) : 'inf';
      return m.shop_price_libre({ min, max, currency: p.currency.toUpperCase() });
    }
    return m.shop_price_free();
  }

  /** Returns a badge label for the product type. */
  function typeLabel(type: AssociationProduct['type']): string {
    return type === 'membership'
      ? m.shop_type_membership()
      : type === 'balance_topup'
        ? m.shop_type_topup()
        : m.shop_type_other();
  }

  /** Returns the reduced cotisant price label, or null when the product has no member pricing. */
  function memberPriceLabel(p: AssociationProduct): string | null {
    if (p.amountCentsMember == null) return null;
    return `${(p.amountCentsMember / 100).toFixed(2)} ${p.currency.toUpperCase()}`;
  }

  /** Sibling tier whose grantedTagName matches this product's memberPriceTag (tier-upgrade pricing), if any. */
  function upgradeSibling(
    p: AssociationProduct,
    siblings: AssociationProduct[]
  ): AssociationProduct | null {
    if (!p.memberPriceTag) return null;
    return siblings.find((s) => s.grantedTagName === p.memberPriceTag) ?? null;
  }

  /**
   * Returns true when the viewer actually qualifies for `amountCentsMember`: either the
   * asso-wide cotisant reduction (no memberPriceTag), or holding the specific sibling tier
   * tag a tier-upgrade price is linked to. Mirrors the server-side check in resolvePurchase.
   */
  function qualifiesForMemberPrice(p: AssociationProduct, siblings: AssociationProduct[]): boolean {
    if (p.amountCentsMember == null) return false;
    if (!p.memberPriceTag) return p.viewerIsCotisant === true;
    const sibling = upgradeSibling(p, siblings);
    return sibling != null && p.viewerActiveTier === sibling.variantKey;
  }
</script>

<div class="mx-auto max-w-4xl space-y-8 px-4 py-6 sm:px-6">
  <div class="flex items-center gap-3">
    <ShoppingBag class="text-cn-accent h-7 w-7 shrink-0" />
    <div>
      <h1 class="text-text-main text-2xl font-extrabold tracking-tight">{m.shop_heading()}</h1>
      <p class="text-text-muted mt-0.5 text-sm">
        {m.shop_subtitle()}
      </p>
    </div>
  </div>

  {#if !isLoggedIn}
    <div class="border-cn-border space-y-3 rounded-2xl border bg-(--cn-surface) p-8 text-center">
      <p class="text-text-main text-lg font-semibold">{m.shop_login_required_title()}</p>
      <p class="text-text-muted text-sm">{m.shop_login_required_desc()}</p>
      <a
        href="/login"
        class="bg-cn-accent inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold text-white transition-opacity hover:opacity-90"
      >
        {m.shop_login_button()}
      </a>
    </div>
  {:else if loading}
    <div class="flex justify-center py-16">
      <div
        class="border-cn-border border-t-cn-accent h-8 w-8 animate-spin rounded-full border-4"
      ></div>
    </div>
  {:else if error}
    <p class="text-sm text-red-500">{error}</p>
  {:else}
    <div class="flex gap-2">
      <button
        type="button"
        onclick={() => (shopTab = 'products')}
        class="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
        {shopTab === 'products'
          ? 'bg-cn-yellow text-cn-ink shadow-sm'
          : 'border-cn-border text-text-muted hover:text-text-main border bg-(--cn-surface)'}"
      >
        <ShoppingBag size={17} />
        {m.shop_tab_products()}
      </button>
      <button
        type="button"
        onclick={() => (shopTab = 'partnerships')}
        class="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors
        {shopTab === 'partnerships'
          ? 'bg-cn-yellow text-cn-ink shadow-sm'
          : 'border-cn-border text-text-muted hover:text-text-main border bg-(--cn-surface)'}"
      >
        <Handshake size={17} />
        {m.shop_tab_partnerships()}
      </button>
    </div>

    {#if shopTab === 'products'}
      {#if grouped.size === 0}
        <div class="border-cn-border rounded-2xl border bg-(--cn-surface) p-10 text-center">
          <p class="text-text-muted text-sm">{m.shop_empty()}</p>
        </div>
      {:else}
        {#each [...grouped.entries()] as [assocId, assocProducts] (assocId)}
          {@const asso = associations.get(assocId)}
          {#if asso}
            <section class="space-y-4">
              <!-- Association header -->
              <div class="flex items-center gap-3">
                <AssociationAvatar name={asso.name} logoUrl={asso.logoUrl} size="md" />
                <div>
                  <a
                    href="/associations/{asso.slug}"
                    class="text-text-main hover:text-cn-accent font-bold transition-colors"
                  >
                    {asso.name}
                  </a>
                  {#if asso.description?.trim()}
                    <div
                      class="text-text-muted [&_.post-markdown]:text-xs [&_.post-markdown]:leading-snug [&_.post-markdown_p]:m-0 [&_.post-markdown_p+p]:mt-0"
                    >
                      <ProfileBioMarkdown source={asso.description} compact />
                    </div>
                  {/if}
                </div>
              </div>

              <!-- Products grid -->
              <div class="grid gap-4 sm:grid-cols-2">
                {#each assocProducts as product (product.id)}
                  {@const sibling = upgradeSibling(product, assocProducts)}
                  {@const memberEligible = qualifiesForMemberPrice(product, assocProducts)}
                  <CardTile
                    iconUrl={product.iconUrl}
                    fallbackIcon={productFallbackIcon(product.type)}
                    accentColor={asso.color ?? generateAvatarColor(asso.name)}
                    badgeText={product.badgeText}
                  >
                    <div class="flex flex-col gap-3 p-5">
                      <!-- Type badge -->
                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <div class="flex flex-wrap items-center gap-1.5">
                          <span
                            class="rounded-full px-2.5 py-0.5 text-xs font-semibold {product.type ===
                            'membership'
                              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                              : product.type === 'balance_topup'
                                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                                : 'bg-cn-surface-alt text-text-muted'}"
                          >
                            {typeLabel(product.type)}
                          </span>
                          {#if product.membersOnly}
                            <span
                              class="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
                            >
                              {m.shop_members_only_badge()}
                            </span>
                          {/if}
                          {#if product.type === 'membership' && product.variantKey !== null && product.viewerActiveTier === product.variantKey}
                            <span
                              class="bg-cn-accent/15 text-cn-accent rounded-full px-2.5 py-0.5 text-xs font-semibold"
                            >
                              {m.shop_current_tier_badge()}
                            </span>
                          {/if}
                        </div>
                        {#if memberEligible && memberPriceLabel(product)}
                          <span class="text-right text-sm font-bold">
                            <span class="text-text-muted font-normal line-through"
                              >{priceLabel(product)}</span
                            >
                            <span class="text-emerald-600 dark:text-emerald-400"
                              >{memberPriceLabel(product)}</span
                            >
                            <span class="text-text-muted block text-xs font-normal sm:inline"
                              >{sibling
                                ? m.shop_tier_upgrade_price_suffix({ tier: sibling.name })
                                : m.shop_member_price_suffix()}</span
                            >
                          </span>
                        {:else}
                          <span class="text-cn-accent text-sm font-bold">{priceLabel(product)}</span
                          >
                        {/if}
                      </div>

                      <div>
                        <p class="text-text-main font-semibold">{product.name}</p>
                        {#if product.description}
                          <p class="text-text-muted mt-1 line-clamp-2 text-xs">
                            {product.description}
                          </p>
                        {/if}
                      </div>

                      <!-- Custom amount input -->
                      {#if product.allowCustomAmount && product.amountCents === null}
                        <div class="flex items-center gap-2">
                          <input
                            type="number"
                            min={product.customAmountMinCents != null
                              ? product.customAmountMinCents / 100
                              : 0}
                            max={product.customAmountMaxCents != null
                              ? product.customAmountMaxCents / 100
                              : undefined}
                            step="0.01"
                            placeholder={m.shop_amount_placeholder()}
                            class="border-cn-border text-text-main focus:ring-cn-accent flex-1 rounded-xl border bg-transparent px-3 py-2 text-sm focus:ring-2 focus:outline-none"
                            bind:value={customAmounts[product.id]}
                          />
                          <span class="text-text-muted text-xs"
                            >{product.currency.toUpperCase()}</span
                          >
                        </div>
                      {/if}

                      <ProductPurchaseButton
                        {product}
                        customAmountEuros={customAmounts[product.id]}
                        disabled={product.membersOnly && !product.viewerIsCotisant}
                        class="w-full"
                      />
                      {#if product.membersOnly && !product.viewerIsCotisant}
                        <p class="text-xs text-amber-700 dark:text-amber-400">
                          {m.shop_members_only_hint()}
                        </p>
                      {/if}
                    </div>
                  </CardTile>
                {/each}
              </div>
            </section>
          {/if}
        {/each}
      {/if}
    {:else if partnershipsGrouped.size === 0}
      <div class="border-cn-border rounded-2xl border bg-(--cn-surface) p-10 text-center">
        <p class="text-text-muted text-sm">{m.shop_partnership_none()}</p>
      </div>
    {:else}
      {#each [...partnershipsGrouped.entries()] as [assocId, assocPartnerships] (assocId)}
        {@const asso = associations.get(assocId)}
        {#if asso}
          <section class="space-y-4">
            <!-- Association header -->
            <div class="flex items-center gap-3">
              <AssociationAvatar name={asso.name} logoUrl={asso.logoUrl} size="md" />
              <div>
                <a
                  href="/associations/{asso.slug}"
                  class="text-text-main hover:text-cn-accent font-bold transition-colors"
                >
                  {asso.name}
                </a>
                {#if asso.description?.trim()}
                  <div
                    class="text-text-muted [&_.post-markdown]:text-xs [&_.post-markdown]:leading-snug [&_.post-markdown_p]:m-0 [&_.post-markdown_p+p]:mt-0"
                  >
                    <ProfileBioMarkdown source={asso.description} />
                  </div>
                {/if}
              </div>
            </div>

            <PartnershipCardList
              cards={assocPartnerships}
              accentColor={asso.color ?? generateAvatarColor(asso.name)}
            />
          </section>
        {/if}
      {/each}
    {/if}
  {/if}
</div>
