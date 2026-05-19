<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import {
    listAllProducts,
    listAssociations,
    createProductCheckout,
    type AssociationProduct,
    type Association,
  } from '$lib/associations/api';
  import { currentUserId } from '$lib/stores/user';
  import AssociationAvatar from '$lib/components/shared/AssociationAvatar.svelte';
  import { ShoppingBag } from '@lucide/svelte';

  let products = $state<AssociationProduct[]>([]);
  let associations = new SvelteMap<string, Association>();
  let loading = $state(true);
  let error = $state('');
  let checkingOut = $state<string | null>(null);
  let customAmounts = $state<Record<string, number>>({});

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
      const [prods, assos] = await Promise.all([listAllProducts(), listAssociations()]);
      products = prods;
      assos.forEach((a) => associations.set(a.id, a));
    } catch (err) {
      error = err instanceof Error ? err.message : 'Impossible de charger la boutique';
    } finally {
      loading = false;
    }
  });

  /** Returns a human-readable price label for a product. */
  function priceLabel(p: AssociationProduct): string {
    if (p.amountCents !== null) {
      return `${(p.amountCents / 100).toFixed(2)} ${p.currency.toUpperCase()}`;
    }
    if (p.allowCustomAmount) {
      const min = p.customAmountMinCents ? (p.customAmountMinCents / 100).toFixed(2) : '0';
      const max = p.customAmountMaxCents ? (p.customAmountMaxCents / 100).toFixed(2) : '∞';
      return `Libre (${min}–${max} ${p.currency.toUpperCase()})`;
    }
    return 'Gratuit';
  }

  /** Returns a badge label for the product type. */
  function typeLabel(type: AssociationProduct['type']): string {
    return type === 'membership' ? 'Cotisation' : type === 'balance_topup' ? 'Recharge' : 'Autre';
  }

  async function handleCheckout(product: AssociationProduct) {
    const asso = associations.get(product.associationId);
    if (!asso) return;

    checkingOut = product.id;
    try {
      const customCents =
        product.allowCustomAmount && product.amountCents === null
          ? Math.round((customAmounts[product.id] ?? 0) * 100)
          : undefined;
      const { checkoutUrl } = await createProductCheckout(
        product.associationId,
        product.id,
        customCents
      );
      window.location.href = checkoutUrl;
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Erreur lors de la création du paiement');
    } finally {
      checkingOut = null;
    }
  }
</script>

<div class="px-4 py-6 sm:px-6 max-w-4xl mx-auto space-y-8">
  <div class="flex items-center gap-3">
    <ShoppingBag class="h-7 w-7 text-cn-accent shrink-0" />
    <div>
      <h1 class="text-2xl font-extrabold text-text-main tracking-tight">Boutique</h1>
      <p class="text-sm text-text-muted mt-0.5">
        Cotisations, recharges et produits des associations
      </p>
    </div>
  </div>

  {#if !isLoggedIn}
    <div
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-8 text-center space-y-3"
    >
      <p class="text-text-main font-semibold text-lg">Connexion requise</p>
      <p class="text-text-muted text-sm">Connectez-vous pour accéder à la boutique.</p>
      <a
        href="/login"
        class="inline-flex items-center gap-2 rounded-xl bg-cn-accent px-5 py-2.5 text-sm font-bold text-white hover:opacity-90 transition-opacity"
      >
        Se connecter
      </a>
    </div>
  {:else if loading}
    <div class="flex justify-center py-16">
      <div class="h-8 w-8 animate-spin rounded-full border-4 border-cn-border border-t-cn-accent"></div>
    </div>
  {:else if error}
    <p class="text-red-500 text-sm">{error}</p>
  {:else if grouped.size === 0}
    <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-10 text-center">
      <p class="text-text-muted text-sm">Aucun produit disponible pour le moment.</p>
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
                <div class="flex items-center justify-between gap-2">
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
                  <span class="text-sm font-bold text-cn-accent">{priceLabel(product)}</span>
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
                      placeholder="Montant (€)"
                      class="flex-1 rounded-xl border border-cn-border bg-transparent px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-cn-accent"
                      bind:value={customAmounts[product.id]}
                    />
                    <span class="text-xs text-text-muted">{product.currency.toUpperCase()}</span>
                  </div>
                {/if}

                <button
                  onclick={() => handleCheckout(product)}
                  disabled={checkingOut === product.id ||
                    (product.allowCustomAmount &&
                      product.amountCents === null &&
                      !customAmounts[product.id])}
                  class="w-full rounded-xl bg-cn-accent px-4 py-2.5 text-sm font-bold text-white hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {#if checkingOut === product.id}
                    <span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></span>
                  {:else if product.type === 'membership'}
                    Cotiser
                  {:else if product.type === 'balance_topup'}
                    Recharger
                  {:else}
                    Acheter
                  {/if}
                </button>
              </div>
            {/each}
          </div>
        </section>
      {/if}
    {/each}
  {/if}
</div>
