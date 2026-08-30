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
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';

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

  /**
   * Products a cash sale may be recorded against. A `balance_topup` is excluded on purpose: it
   * credits a balance on the Cercle's own books, which a Canari cash grant never does, so offering
   * it here only ever reads as "this recharged them" when it did not. The bar credits a member
   * from the Cercle's own till screen.
   */
  const grantableProducts = $derived(products.filter((p) => p.type !== 'balance_topup'));
  const grantSelectedProduct = $derived(grantableProducts.find((p) => p.id === grantProductId));
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
      purchasesError = e instanceof Error ? e.message : 'Error';
    } finally {
      purchasesLoading = false;
    }
  }

  function purchaseBuyerName(purchase: AssociationPurchase): string {
    if (purchase.firstName || purchase.lastName) {
      return `${purchase.firstName ?? ''} ${purchase.lastName ?? ''}`.trim();
    }
    return getUserDisplayNameSync(purchase.userId);
  }

  /** Maps a payment method identifier to its display label. */
  function paymentMethodLabel(method: AssociationPurchase['paymentMethod']): string {
    if (method === 'cash') return m.asso_achats_payment_cash();
    if (method === 'stripe') return m.asso_achats_payment_online();
    return method;
  }

  async function handleGrantProduct() {
    if (!grantUserId.trim() || !grantProductId) return;
    if (grantNeedsAmount && grantAmountEuros === '') {
      purchasesError = m.asso_achats_grant_amount_error();
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
      purchasesError = e instanceof Error ? e.message : 'Error';
    } finally {
      grantingProduct = false;
    }
  }
</script>

<div class="border-cn-border space-y-5 rounded-2xl border bg-[var(--cn-surface)]/95 p-6 shadow-sm">
  <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <h2 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
        <UsersIcon size={20} />
        {m.asso_achats_title()}
      </h2>
      <p class="text-text-muted mt-1 text-sm">
        {m.asso_achats_subtitle()}
      </p>
    </div>
    <div class="w-full space-y-1 sm:w-64">
      <label for="purchase-filter" class="text-text-muted text-xs font-semibold"
        >{m.asso_achats_filter_label()}</label
      >
      <select
        id="purchase-filter"
        bind:value={purchaseFilterProductId}
        class="border-cn-border w-full rounded-xl border bg-(--cn-surface) px-3 py-2 text-sm"
      >
        <option value="">{m.asso_achats_filter_all()}</option>
        {#each products as product (product.id)}
          <option value={product.id}>{product.name}</option>
        {/each}
      </select>
    </div>
  </div>

  <form
    class="border-cn-border bg-cn-bg/40 space-y-4 rounded-xl border p-4"
    onsubmit={(e) => {
      e.preventDefault();
      void handleGrantProduct();
    }}
  >
    <h3 class="text-text-main flex items-center gap-2 text-sm font-bold">
      <Gift size={16} />
      {m.asso_achats_grant_title()}
    </h3>
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div class="sm:col-span-2">
        <label for="grant-user" class="text-text-muted mb-1 block text-xs font-semibold"
          >{m.asso_achats_grant_user_label()}</label
        >
        <UserAutocomplete
          value={grantUserId}
          onValueChange={(v) => (grantUserId = v)}
          placeholder={m.asso_members_user_placeholder()}
          inputId="grant-user"
          onSubmit={handleGrantProduct}
        />
      </div>
      <div>
        <label for="grant-product" class="text-text-muted mb-1 block text-xs font-semibold"
          >{m.asso_achats_grant_product_label()}</label
        >
        <select
          id="grant-product"
          bind:value={grantProductId}
          class="border-cn-border w-full rounded-xl border bg-[var(--cn-surface)] px-3 py-2.5 text-sm"
          required
        >
          <option value="">{m.asso_achats_grant_product_placeholder()}</option>
          {#each grantableProducts as product (product.id)}
            <option value={product.id}>{product.name}</option>
          {/each}
        </select>
      </div>
      {#if grantNeedsAmount}
        <div>
          <label for="grant-amount" class="text-text-muted mb-1 block text-xs font-semibold"
            >{m.asso_achats_grant_amount_label()}</label
          >
          <input
            id="grant-amount"
            type="number"
            min="0"
            step="0.01"
            bind:value={grantAmountEuros}
            placeholder="0.00"
            class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2.5 text-sm"
            required
          />
        </div>
      {/if}
    </div>
    <p class="text-text-muted text-xs">
      {#if grantSelectedProduct?.type === 'membership' && grantSelectedProduct.grantedTagName}
        {m.asso_achats_grant_tag_hint({ tag: grantSelectedProduct.grantedTagName })}
      {:else}
        {m.asso_achats_grant_other_hint()}
      {/if}
    </p>
    <button
      type="submit"
      disabled={grantingProduct || !grantUserId.trim() || !grantProductId}
      class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-5 py-2.5 text-sm font-bold disabled:opacity-50"
    >
      {grantingProduct ? m.asso_achats_grant_submitting() : m.asso_achats_grant_button()}
    </button>
  </form>

  {#if purchasesError}
    <div class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-4 py-3 text-sm">
      {purchasesError}
    </div>
  {/if}

  {#if purchasesLoading}
    <div class="flex justify-center py-8">
      <div
        class="border-cn-yellow h-6 w-6 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else if filteredPurchases.length === 0}
    <p class="text-text-muted py-8 text-center text-sm">{m.asso_achats_no_purchases()}</p>
  {:else}
    <div class="border-cn-border/70 overflow-x-auto rounded-xl border">
      <table class="w-full text-sm">
        <thead
          class="bg-cn-bg/60 text-text-muted text-left text-xs font-bold tracking-wide uppercase"
        >
          <tr>
            <th class="px-4 py-3">{m.asso_achats_col_date()}</th>
            <th class="px-4 py-3">{m.asso_achats_col_buyer()}</th>
            <th class="px-4 py-3">{m.asso_achats_col_item()}</th>
            <th class="px-4 py-3">{m.asso_achats_col_type()}</th>
            <th class="px-4 py-3">{m.asso_achats_col_payment()}</th>
            <th class="px-4 py-3 text-right">{m.asso_achats_col_amount()}</th>
          </tr>
        </thead>
        <tbody class="divide-cn-border/50 divide-y">
          {#each filteredPurchases as purchase (purchase.id)}
            <tr class="bg-cn-bg/20 hover:bg-cn-bg/40">
              <td class="text-text-muted px-4 py-3 whitespace-nowrap">
                {new Date(purchase.paidAt).toLocaleString(getLocale() === 'en' ? 'en-US' : 'fr-FR')}
              </td>
              <td class="text-text-main px-4 py-3 font-medium">{purchaseBuyerName(purchase)}</td>
              <td class="text-text-main px-4 py-3">{purchase.productName}</td>
              <td class="px-4 py-3">
                <span
                  class="rounded-full px-2 py-0.5 text-xs font-semibold {purchase.source ===
                  'product'
                    ? 'bg-green-ok/15 text-green-ok'
                    : 'bg-sky-500/15 text-sky-600 dark:text-sky-400'}"
                >
                  {purchase.source === 'product'
                    ? m.asso_achats_source_product()
                    : m.asso_achats_source_form()}
                </span>
              </td>
              <td class="text-text-muted px-4 py-3">{paymentMethodLabel(purchase.paymentMethod)}</td
              >
              <td class="px-4 py-3 text-right font-semibold tabular-nums">
                {(purchase.amountCents / 100).toFixed(2)} €
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="text-text-muted text-right text-xs">
      {m.asso_achats_count_label({ count: filteredPurchases.length })}
    </p>
  {/if}
</div>
