<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listAssociationProductsForManage,
    listAssociationPurchases,
    grantProductPurchase,
    type Association,
    type AssociationProduct,
    type AssociationPurchase,
  } from '$lib/associations/api';
  import { Gift, Users as UsersIcon } from '@lucide/svelte';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';

  interface Props {
    asso: Association;
  }

  let { asso }: Props = $props();

  let products = $state<AssociationProduct[]>([]);
  let purchases = $state<AssociationPurchase[]>([]);
  let purchasesLoading = $state(false);
  let purchasesError = $state('');
  let purchaseFilterProductId = $state('');
  let grantUserId = $state('');
  let grantProductId = $state('');
  let grantAmountEuros = $state<number | ''>('');
  let grantingProduct = $state(false);

  const grantSelectedProduct = $derived(products.find((p) => p.id === grantProductId));
  const grantNeedsAmount = $derived(
    grantSelectedProduct != null && grantSelectedProduct.amountCents == null
  );
  const filteredPurchases = $derived(
    purchaseFilterProductId
      ? purchases.filter((p) => p.productId === purchaseFilterProductId)
      : purchases
  );

  onMount(loadPurchases);

  async function loadPurchases() {
    purchasesLoading = true;
    purchasesError = '';
    try {
      const [prods, rows] = await Promise.all([
        listAssociationProductsForManage(asso.id),
        listAssociationPurchases(asso.id),
      ]);
      products = prods;
      purchases = rows;
    } catch (e) {
      purchasesError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      purchasesLoading = false;
    }
  }

  function purchaseBuyerName(purchase: AssociationPurchase): string {
    if (purchase.firstName || purchase.lastName) {
      return `${purchase.firstName ?? ''} ${purchase.lastName ?? ''}`.trim();
    }
    return purchase.userId.slice(0, 8) + '…';
  }

  function paymentMethodLabel(method: AssociationPurchase['paymentMethod']): string {
    if (method === 'cash') return 'Espèces / manuel';
    if (method === 'stripe') return 'Stripe';
    return method;
  }

  async function handleGrantProduct() {
    if (!grantUserId.trim() || !grantProductId) return;
    if (grantNeedsAmount && grantAmountEuros === '') {
      purchasesError = 'Indiquez le montant payé pour ce produit.';
      return;
    }
    grantingProduct = true;
    purchasesError = '';
    try {
      await grantProductPurchase(asso.id, grantProductId, {
        userId: grantUserId.trim(),
        ...(grantNeedsAmount && grantAmountEuros !== ''
          ? { amountCents: Math.round(Number(grantAmountEuros) * 100) }
          : {}),
      });
      grantUserId = '';
      grantProductId = '';
      grantAmountEuros = '';
      await loadPurchases();
    } catch (e) {
      purchasesError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      grantingProduct = false;
    }
  }
</script>

<div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-5 shadow-sm">
  <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
    <div>
      <h2 class="text-lg font-bold text-text-main tracking-tight flex items-center gap-2">
        <UsersIcon size={20} />
        Achats et acheteurs
      </h2>
      <p class="text-sm text-text-muted mt-1">
        Historique des paiements boutique et formulaires payants. Attribuez un produit manuellement
        (espèces, paiement antérieur à Canari).
      </p>
    </div>
    <div class="w-full sm:w-64 space-y-1">
      <label for="purchase-filter" class="text-xs font-semibold text-text-muted"
        >Filtrer par produit</label
      >
      <select
        id="purchase-filter"
        bind:value={purchaseFilterProductId}
        class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm"
      >
        <option value="">Tous les achats</option>
        {#each products as product (product.id)}
          <option value={product.id}>{product.name}</option>
        {/each}
      </select>
    </div>
  </div>

  <form
    class="rounded-xl border border-cn-border bg-cn-bg/40 p-4 space-y-4"
    onsubmit={(e) => {
      e.preventDefault();
      void handleGrantProduct();
    }}
  >
    <h3 class="text-sm font-bold text-text-main flex items-center gap-2">
      <Gift size={16} />
      Attribuer un produit
    </h3>
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div class="sm:col-span-2">
        <label for="grant-user" class="text-xs font-semibold text-text-muted block mb-1"
          >Utilisateur</label
        >
        <UserAutocomplete
          value={grantUserId}
          onValueChange={(v) => (grantUserId = v)}
          placeholder="Rechercher un utilisateur…"
          inputId="grant-user"
          onSubmit={handleGrantProduct}
        />
      </div>
      <div>
        <label for="grant-product" class="text-xs font-semibold text-text-muted block mb-1"
          >Produit</label
        >
        <select
          id="grant-product"
          bind:value={grantProductId}
          class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2.5 text-sm"
          required
        >
          <option value="">Choisir…</option>
          {#each products as product (product.id)}
            <option value={product.id}>{product.name}</option>
          {/each}
        </select>
      </div>
      {#if grantNeedsAmount}
        <div>
          <label for="grant-amount" class="text-xs font-semibold text-text-muted block mb-1"
            >Montant payé (€)</label
          >
          <input
            id="grant-amount"
            type="number"
            min="0"
            step="0.01"
            bind:value={grantAmountEuros}
            placeholder="0.00"
            class="w-full rounded-xl border border-cn-border bg-transparent px-3 py-2.5 text-sm"
            required
          />
        </div>
      {/if}
    </div>
    <p class="text-xs text-text-muted">
      {#if grantSelectedProduct?.type === 'membership' && grantSelectedProduct.grantedTagName}
        Le tag <span class="font-mono">{grantSelectedProduct.grantedTagName}</span> sera accordé
        automatiquement.
      {:else if grantSelectedProduct?.type === 'balance_topup'}
        Les recharges Cercle ne sont pas créditées automatiquement - utilisez l'interface Cercle si
        nécessaire.
      {:else}
        L'achat apparaîtra dans l'historique comme un paiement manuel.
      {/if}
    </p>
    <button
      type="submit"
      disabled={grantingProduct || !grantUserId.trim() || !grantProductId}
      class="rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
    >
      {grantingProduct ? 'Attribution…' : 'Attribuer comme acheté'}
    </button>
  </form>

  {#if purchasesError}
    <div class="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">
      {purchasesError}
    </div>
  {/if}

  {#if purchasesLoading}
    <div class="flex justify-center py-8">
      <div class="h-6 w-6 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"></div>
    </div>
  {:else if filteredPurchases.length === 0}
    <p class="text-sm text-text-muted text-center py-8">Aucun achat enregistré.</p>
  {:else}
    <div class="overflow-x-auto rounded-xl border border-cn-border/70">
      <table class="w-full text-sm">
        <thead
          class="bg-cn-bg/60 text-left text-xs font-bold uppercase tracking-wide text-text-muted"
        >
          <tr>
            <th class="px-4 py-3">Date</th>
            <th class="px-4 py-3">Acheteur</th>
            <th class="px-4 py-3">Article</th>
            <th class="px-4 py-3">Type</th>
            <th class="px-4 py-3">Paiement</th>
            <th class="px-4 py-3 text-right">Montant</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-cn-border/50">
          {#each filteredPurchases as purchase (purchase.id)}
            <tr class="bg-cn-bg/20 hover:bg-cn-bg/40">
              <td class="px-4 py-3 text-text-muted whitespace-nowrap">
                {new Date(purchase.paidAt).toLocaleString('fr-FR')}
              </td>
              <td class="px-4 py-3 font-medium text-text-main">{purchaseBuyerName(purchase)}</td>
              <td class="px-4 py-3 text-text-main">{purchase.productName}</td>
              <td class="px-4 py-3">
                <span
                  class="rounded-full px-2 py-0.5 text-xs font-semibold {purchase.source === 'product'
                    ? 'bg-emerald-100 text-emerald-700'
                    : 'bg-sky-100 text-sky-700'}"
                >
                  {purchase.source === 'product' ? 'Boutique' : 'Formulaire'}
                </span>
              </td>
              <td class="px-4 py-3 text-text-muted">{paymentMethodLabel(purchase.paymentMethod)}</td>
              <td class="px-4 py-3 text-right font-semibold tabular-nums">
                {(purchase.amountCents / 100).toFixed(2)} €
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="text-xs text-text-muted text-right">
      {filteredPurchases.length} achat{filteredPurchases.length > 1 ? 's' : ''}
    </p>
  {/if}
</div>
