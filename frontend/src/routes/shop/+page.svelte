<script lang="ts">
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import { CARD_GRID } from '$lib/components/layout/cardGrid';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { SvelteMap } from 'svelte/reactivity';
  import {
    listAllProducts,
    listAssociations,
    listAllPartnerships,
    confirmProductCheckout,
    SocialApiError,
    type AssociationProduct,
    type Association,
    type PartnershipCard,
  } from '$lib/associations/api';
  import { currentUserId } from '$lib/stores/user';
  import { gridPriceIsProvisional, gridPriceLabel, gridRefuses } from '$lib/pricing/viewerPrice';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import ProductPurchaseButton from '$lib/components/shop/ProductPurchaseButton.svelte';
  import PartnershipCardList from '$lib/components/shop/PartnershipCardList.svelte';
  import CardTile from '$lib/components/shared/CardTile.svelte';
  import { productFallbackIcon } from '$lib/utils/cardIcons';
  import { ShoppingBag, Handshake } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { associationAccent } from '$lib/associations/accent';
  import { customAmountLabel } from '$lib/associations/customAmountLabel';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import { parseTab, tabUrl, withoutQuery } from '$lib/navigation/tabQuery';
  import { internalPath } from '$lib/utils/internalPath';
  import { Log } from '$lib/utils/Log';
  import {
    CHECKOUT_RETURN_PARAMS,
    checkoutReturnTarget,
    checkoutReturnView,
    type CheckoutReturnView,
  } from '$lib/shop/checkoutReturn';

  let products = $state<AssociationProduct[]>([]);
  let partnerships = $state<PartnershipCard[]>([]);
  let associations = new SvelteMap<string, Association>();
  let loading = $state(true);
  let error = $state('');
  let customAmounts = $state<Record<string, number>>({});
  const SHOP_TABS = ['products', 'partnerships'] as const;
  type ShopTab = (typeof SHOP_TABS)[number];
  /** What the page says about the checkout attempt the payer came back from, if any. */
  let checkoutReturn = $state<CheckoutReturnView | null>(null);
  /** Ceiling on how long the page keeps asking before it says the payment is still unconfirmed. */
  const MAX_CHECKOUT_POLLS = 10;
  const CHECKOUT_POLL_INTERVAL_MS = 3000;
  let destroyed = false;
  onDestroy(() => {
    destroyed = true;
  });

  /**
   * Asks the server about the attempt the return URL names, while it is still open: each read has
   * the server ask Lydia about the attempt's own request and record it if paid, so a payment whose
   * callback was lost is still confirmed here. A 404 is an attempt that is not the reader's, or
   * unknown; a 429 is the server's per-attempt limit on asking Lydia - an answer, not a failure.
   */
  async function followCheckout(target: NonNullable<ReturnType<typeof checkoutReturnTarget>>) {
    checkoutReturn = 'checking';
    try {
      for (let attempt = 0; attempt < MAX_CHECKOUT_POLLS && !destroyed; attempt++) {
        const answer = await confirmProductCheckout(
          target.associationId,
          target.productId,
          target.checkoutId
        );
        checkoutReturn = checkoutReturnView(answer.status);
        Log.d('shop: checkout return', answer.status);
        if (checkoutReturn !== 'waiting') {
          // A purchase changes what the listing says (a tier now held, a cap reached).
          if (checkoutReturn === 'paid') products = await listAllProducts();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, CHECKOUT_POLL_INTERVAL_MS));
      }
    } catch (err) {
      if (err instanceof SocialApiError && err.status === 404) {
        console.warn('[shop] checkout return names an attempt that is not found');
        checkoutReturn = 'unknown';
        return;
      }
      if (err instanceof SocialApiError && err.status === 429) {
        console.info('[shop] confirmation limit reached, the payment stays awaited');
        checkoutReturn = 'waiting';
        return;
      }
      console.error('[shop] could not read the checkout attempt:', err);
      checkoutReturn = 'waiting';
    }
  }

  const CHECKOUT_RETURN_TEXT: Record<CheckoutReturnView, () => string> = {
    checking: () => m.shop_return_checking(),
    paid: () => m.shop_return_paid(),
    waiting: () => m.shop_return_waiting(),
    declined: () => m.shop_return_declined(),
    notCompleted: () => m.shop_return_not_completed(),
    unknown: () => m.shop_return_unknown(),
  };
  // `?tab=` keeps the segment across a reload; written as a shallow `goto`, see `tabQuery`.
  let shopTab = $state<ShopTab>(parseTab(page.url.searchParams.get('tab'), SHOP_TABS, 'products'));

  /** Opens a segment without adding a history entry: Back still leaves the shop. */
  function switchTab(next: ShopTab) {
    Log.d('shop: segment', next);
    shopTab = next;
    void goto(resolve(internalPath(tabUrl(page.url, next, 'products'))), {
      shallow: true,
      replace: true,
      state: page.state,
    });
  }

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
      error = m.shop_load_error_fallback();
    } finally {
      loading = false;
    }

    // The checkout return is consumed once. Through SvelteKit's shallow `goto`, never the raw
    // History API: a raw write erased the router's own entry state, and the open `?tab=` with it.
    // Success and fail URLs land here alike: what the payer is told is the ATTEMPT's status, read
    // from the server, never which of Lydia's two URLs sent them back.
    const params = page.url.searchParams;
    if (CHECKOUT_RETURN_PARAMS.some((name) => params.has(name))) {
      const target = checkoutReturnTarget(params);
      void goto(resolve(internalPath(withoutQuery(page.url, CHECKOUT_RETURN_PARAMS))), {
        shallow: true,
        replace: true,
        state: page.state,
      });
      if (target) void followCheckout(target);
      else console.warn('[shop] checkout return names no attempt, nothing to confirm');
    }
  });

  /** Returns a human-readable price label for a product. */
  function priceLabel(p: AssociationProduct): string {
    // A grid answers first and alone: while one is set the product's own amount decides nothing,
    // server-side included, so printing it here would name a figure no checkout would charge.
    const gridded = gridPriceLabel(p);
    if (gridded !== null) return gridded;
    if (p.amountCents !== null) {
      return `${(p.amountCents / 100).toFixed(2)} ${p.currency.toUpperCase()}`;
    }
    if (p.allowCustomAmount) {
      return customAmountLabel(p);
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
    // A grid replaces the member price rather than competing with it - the cotisation criterion is
    // where a gridded product says what a cotisant pays.
    if (p.viewerPrice?.kind === 'grid') return false;
    if (p.amountCentsMember == null) return false;
    if (!p.memberPriceTag) return p.viewerIsCotisant === true;
    const sibling = upgradeSibling(p, siblings);
    return sibling != null && p.viewerActiveTier === sibling.variantKey;
  }
</script>

<PageContainer width="grid">
  <PageHeader title={m.shop_heading()} subtitle={m.shop_subtitle()} />

  <div class="space-y-8">
    {#if !isLoggedIn}
      <div class="border-cn-border space-y-3 rounded-2xl border bg-(--cn-surface) p-8 text-center">
        <p class="text-text-main text-lg font-semibold">{m.shop_login_required_title()}</p>
        <p class="text-text-muted text-sm">{m.shop_login_required_desc()}</p>
        <a
          href={resolve('/login')}
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold transition-opacity"
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
      {#if checkoutReturn}
        <div
          role="status"
          data-checkout-return={checkoutReturn}
          class="border-cn-border rounded-2xl border bg-(--cn-surface) p-4 text-sm {checkoutReturn ===
          'paid'
            ? 'text-emerald-700 dark:text-emerald-400'
            : checkoutReturn === 'declined' || checkoutReturn === 'notCompleted'
              ? 'text-amber-700 dark:text-amber-400'
              : 'text-text-muted'}"
        >
          {CHECKOUT_RETURN_TEXT[checkoutReturn]()}
        </div>
      {/if}
      <SegmentedControl
        items={[
          { key: 'products', label: m.shop_tab_products(), icon: ShoppingBag },
          { key: 'partnerships', label: m.shop_tab_partnerships(), icon: Handshake },
        ]}
        value={shopTab}
        onSelect={switchTab}
        label={m.shop_heading()}
        tone="yellow"
      />

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
                <div class={CARD_GRID}>
                  {#each assocProducts as product (product.id)}
                    {@const sibling = upgradeSibling(product, assocProducts)}
                    {@const memberEligible = qualifiesForMemberPrice(product, assocProducts)}
                    <CardTile
                      iconUrl={product.iconUrl}
                      fallbackIcon={productFallbackIcon(product.type)}
                      accentColor={associationAccent(asso)}
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
                            <span class="text-cn-accent text-sm font-bold"
                              >{priceLabel(product)}</span
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
                          <!-- `min-w-0` on the input, and it is load-bearing: a flex item's
                               `min-width` is `auto`, which resolves to its MIN-CONTENT width, and
                               a bare `input type=number` carries an intrinsic one of about 170px
                               that `flex-1` cannot shrink past. The row therefore overflowed its
                               card the moment the card stopped being 388px wide - measured
                               2026-09-10 on a 242px tile, with the currency label cut in half.
                               Exactly the trap `/calendar/export` hit on a grid `1fr` track. -->
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
                              class="border-cn-border text-text-main focus:ring-cn-accent w-full min-w-0 flex-1 rounded-xl border bg-transparent px-3 py-2 text-sm focus:ring-2 focus:outline-none"
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
                          disabled={(product.membersOnly && !product.viewerIsCotisant) ||
                            gridRefuses(product)}
                          class="w-full"
                        />
                        {#if gridRefuses(product)}
                          <p class="text-xs text-amber-700 dark:text-amber-400">
                            {m.shop_price_unavailable_hint()}
                          </p>
                        {:else if gridPriceIsProvisional(product, isLoggedIn)}
                          <p class="text-text-muted text-xs">{m.shop_price_profile_hint()}</p>
                        {/if}
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
                accentColor={associationAccent(asso)}
              />
            </section>
          {/if}
        {/each}
      {/if}
    {/if}
  </div>
</PageContainer>
