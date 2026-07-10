<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { showToast } from '$lib/stores/toast.svelte';
  import {
    listAllProducts,
    listAssociations,
    deriveCotisationTagName,
    type AssociationProduct,
    type Association,
  } from '$lib/associations/api';
  import { getMyActiveTags } from '$lib/forms/api';
  import { currentUserId } from '$lib/stores/user';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import ProductPurchaseButton from '$lib/components/shop/ProductPurchaseButton.svelte';
  import { ShoppingBag } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  let products = $state<AssociationProduct[]>([]);
  let associations = new SvelteMap<string, Association>();
  let loading = $state(true);
  let error = $state('');
  let customAmounts = $state<Record<string, number>>({});
  /** Tag names the current user actively holds, used to gate/label members-only products. */
  let myTagNames = $state<Set<string>>(new Set());

  const isLoggedIn = $derived(!!currentUserId());

  /** Products grouped by associationId. */
  const grouped = $derived.by(() => {
    const map = new SvelteMap<string, AssociationProduct[]>();
    for (const p of products) {
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
      const [prods, assos, activeTags] = await Promise.all([
        listAllProducts(),
        listAssociations(),
        getMyActiveTags().catch((e) => {
          console.error('[Shop] Failed to load active tags:', e);
          return [];
        }),
      ]);
      products = prods;
      assos.forEach((a) => associations.set(a.id, a));
      myTagNames = new Set(activeTags.map((t) => t.tagName));
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

  /**
   * True when the current user holds the product's association active cotisation tag.
   * Mirrors the backend's `isBuyerCotisant` (products.service.ts) using the already-fetched
   * active tags, so members-only products can be gated/labeled without a dedicated endpoint.
   */
  function isCotisant(product: AssociationProduct): boolean {
    const asso = associations.get(product.associationId);
    if (!asso?.cotisationMode) return false;
    return myTagNames.has(deriveCotisationTagName(asso.slug, asso.cotisationMode));
  }
</script>

<div class="px-4 py-6 sm:px-6 max-w-4xl mx-auto space-y-8">
  <div class="flex items-center gap-3">
    <ShoppingBag class="h-7 w-7 text-cn-accent shrink-0" />
    <div>
      <h1 class="text-2xl font-extrabold text-text-main tracking-tight">{m.shop_heading()}</h1>
      <p class="text-sm text-text-muted mt-0.5">
        {m.shop_subtitle()}
      </p>
    </div>
  </div>

  {#if !isLoggedIn}
    <div
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-8 text-center space-y-3"
    >
      <p class="text-text-main font-semibold text-lg">{m.shop_login_required_title()}</p>
      <p class="text-text-muted text-sm">{m.shop_login_required_desc()}</p>
      <a
        href="/login"
        class="inline-flex items-center gap-2 rounded-xl bg-cn-accent px-5 py-2.5 text-sm font-bold text-white hover:opacity-90 transition-opacity"
      >
        {m.shop_login_button()}
      </a>
    </div>
  {:else if loading}
    <div class="flex justify-center py-16">
      <div
        class="h-8 w-8 animate-spin rounded-full border-4 border-cn-border border-t-cn-accent"
      ></div>
    </div>
  {:else if error}
    <p class="text-red-500 text-sm">{error}</p>
  {:else if grouped.size === 0}
    <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-10 text-center">
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
                class="font-bold text-text-main hover:text-cn-accent transition-colors"
              >
                {asso.name}
              </a>
              {#if asso.description}
                <p class="text-xs text-text-muted">{asso.description}</p>
              {/if}
            </div>
          </div>

          <!-- Products grid -->
          <div class="grid gap-4 sm:grid-cols-2">
            {#each assocProducts as product (product.id)}
              <div
                class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-5 flex flex-col gap-3"
              >
                <!-- Type badge -->
                <div class="flex items-center justify-between gap-2 flex-wrap">
                  <div class="flex items-center gap-1.5 flex-wrap">
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
                        class="rounded-full px-2.5 py-0.5 text-xs font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
                      >
                        {m.shop_members_only_badge()}
                      </span>
                    {/if}
                  </div>
                  {#if memberPriceLabel(product)}
                    <span class="text-sm font-bold text-right">
                      <span class="line-through text-text-muted font-normal"
                        >{priceLabel(product)}</span
                      >
                      <span class="text-emerald-600 dark:text-emerald-400"
                        >{memberPriceLabel(product)}</span
                      >
                      <span class="text-xs text-text-muted font-normal block sm:inline"
                        >{m.shop_member_price_suffix()}</span
                      >
                    </span>
                  {:else}
                    <span class="text-sm font-bold text-cn-accent">{priceLabel(product)}</span>
                  {/if}
                </div>

                <div>
                  <p class="font-semibold text-text-main">{product.name}</p>
                  {#if product.description}
                    <p class="text-xs text-text-muted mt-1 line-clamp-2">{product.description}</p>
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
                      class="flex-1 rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-cn-accent"
                      bind:value={customAmounts[product.id]}
                    />
                    <span class="text-xs text-text-muted">{product.currency.toUpperCase()}</span>
                  </div>
                {/if}

                <ProductPurchaseButton
                  {product}
                  customAmountEuros={customAmounts[product.id]}
                  disabled={product.membersOnly && !isCotisant(product)}
                  class="w-full"
                />
                {#if product.membersOnly && !isCotisant(product)}
                  <p class="text-xs text-amber-700 dark:text-amber-400">
                    {m.shop_members_only_hint()}
                  </p>
                {/if}
              </div>
            {/each}
          </div>
        </section>
      {/if}
    {/each}
  {/if}
</div>
