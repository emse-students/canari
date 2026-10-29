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
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import MembershipCard from '$lib/components/shop/MembershipCard.svelte';
  import ProductCard from '$lib/components/shop/ProductCard.svelte';
  import PartnershipCardList from '$lib/components/shop/PartnershipCardList.svelte';
  import { ShoppingBag, Handshake } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { associationAccent } from '$lib/associations/accent';
  import {
    cotisationDisabledForAssociation,
    hasUnrankedTier,
    nonTierProducts,
    offeredTiers,
  } from '$lib/shop/productCards';
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
  /** The type of the product the payer paid for, so the banner can say what the payment bought. */
  let returnProductType = $state<AssociationProduct['type'] | null>(null);
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
    returnProductType = products.find((p) => p.id === target.productId)?.type ?? null;
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

  /**
   * What a paid return says. The confirm answer carries only the attempt's STATUS - no amount and
   * no Cercle delivery state - so a top-up says the payment was received and the credit follows,
   * never that it already landed.
   */
  function paidText(): string {
    if (returnProductType === 'balance_topup') return m.shop_return_topup_paid();
    if (returnProductType === 'membership') return m.shop_return_membership_paid();
    return m.shop_return_paid();
  }

  const CHECKOUT_RETURN_TEXT: Record<CheckoutReturnView, () => string> = {
    checking: () => m.shop_return_checking(),
    paid: paidText,
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
            {@const tiers = offeredTiers(assocProducts)}
            {@const others = nonTierProducts(assocProducts)}
            {@const disabled = cotisationDisabledForAssociation(assocProducts)}
            {#if asso && (tiers.length > 0 || others.length > 0 || disabled)}
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

                <!-- One membership card with the tiers inside, then one card per other product -->
                <div class={CARD_GRID}>
                  {#if tiers.length > 0 || disabled}
                    <MembershipCard
                      {tiers}
                      allProducts={assocProducts}
                      accentColor={associationAccent(asso)}
                      unrankedHint={hasUnrankedTier(assocProducts)}
                      cotisationDisabled={disabled}
                      signedIn={isLoggedIn}
                    />
                  {/if}
                  {#each others as product (product.id)}
                    <ProductCard
                      {product}
                      siblings={assocProducts}
                      accentColor={associationAccent(asso)}
                      bind:customAmountCents={customAmounts[product.id]}
                      signedIn={isLoggedIn}
                    />
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
