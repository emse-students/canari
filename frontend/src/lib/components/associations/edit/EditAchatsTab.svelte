<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listAssociationProductsForManage,
    listAssociationPurchases,
    grantProductPurchase,
    quoteCashSale,
    closePaidNotGranted,
    listAssociationRefunds,
    getAssociationStatement,
    SocialApiError,
    type Association,
    type AssociationProduct,
    type AssociationPurchase,
    type CashSaleQuote,
    type PurchaseClosingOutcome,
    type AssociationRefund,
    type RefundStanding,
  } from '$lib/associations/api';
  import { Gift, Users as UsersIcon } from '@lucide/svelte';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';
  import Picker from '$lib/components/ui/Picker.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import { purchaseBuyerName } from '$lib/associations/purchaseBuyer';
  import { productLabel, purchaseItemLabel } from '$lib/associations/productLabel';
  import { formatAmount } from '$lib/forms/fillAnswers';
  import { providerRefusalMessage } from '$lib/associations/paymentRefusal';
  import { closingRefusalMessage, grantRefusalMessage } from '$lib/associations/purchaseClosing';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { refusalCode, refusalStatus } from '$lib/utils/apiRefusal';
  import { Log } from '$lib/utils/Log';
  import { downloadDecryptedFile } from '$lib/utils/fileDownload';
  import RefundDialog from './RefundDialog.svelte';
  import RefundCheckDialog from './RefundCheckDialog.svelte';
  import {
    notRefundableHint,
    refundStateLabel,
    statementCsv,
    unconfirmedRefund,
  } from '$lib/associations/refundWording';

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
   * What the sale records if no amount is typed, quoted by the server for the chosen pair (the
   * preferential price when the beneficiary qualifies). Null until both are chosen and answered.
   */
  let grantQuote = $state<CashSaleQuote | null>(null);
  /** Only the latest pair's answer is shown: an earlier one landing late is dropped. */
  let quoteSeq = 0;
  /** The purchase whose outcome is being recorded, so its two buttons cannot be clicked twice. */
  let closingId = $state<string | null>(null);

  /**
   * Products a cash sale may be recorded against. A `balance_topup` is excluded on purpose: it
   * credits a balance on the Cercle's own books, which a Canari cash grant never does, so offering
   * it here only ever reads as "this recharged them" when it did not. The bar credits a member
   * from the Cercle's own till screen.
   */
  const grantableProducts = $derived(products.filter((p) => p.type !== 'balance_topup'));
  const grantSelectedProduct = $derived(grantableProducts.find((p) => p.id === grantProductId));
  /** No default to record: a free amount, or a grid that does not sell to this beneficiary. */
  const grantNeedsAmount = $derived(
    grantQuote != null
      ? grantQuote.kind !== 'priced'
      : grantSelectedProduct != null && grantSelectedProduct.amountCents == null
  );
  const filteredPurchases = $derived(
    purchaseFilterProductId
      ? purchases.filter((p) => p.productId === purchaseFilterProductId)
      : purchases
  );
  /** Products by id, so a purchase line can be named by its product's type (a Cercle top-up). */
  const productsById = $derived(new Map(products.map((p) => [p.id, p])));
  const filterOptions = $derived<PickerOption[]>([
    { value: '', label: m.asso_achats_filter_all() },
    ...products.map((p) => ({ value: p.id, label: productLabel(p) })),
  ]);
  const grantProductOptions = $derived<PickerOption[]>(
    grantableProducts.map((p) => ({ value: p.id, label: productLabel(p) }))
  );

  onMount(() => {
    void loadPurchases();
    void loadRefunds();
  });

  /**
   * LYDIA REFUNDS (lot 4) - for a MANAGE_PAYOUT_ACCOUNT holder only. Null while not loaded, and for
   * a member without that permission: the server answers 403 and the refund buttons, states and
   * statement simply do not show (this tab itself asks MANAGE_PRODUCTS).
   */
  let refundView = $state<{ standings: RefundStanding[]; refunds: AssociationRefund[] } | null>(
    null
  );
  /** The payment the refund dialog is open on, and the unconfirmed refund the check is open on. */
  let refundTarget = $state<AssociationPurchase | null>(null);
  let checkTarget = $state<{ refund: AssociationRefund; buyer: string } | null>(null);
  let statementBusy = $state(false);
  let statementError = $state('');
  const standingsById = $derived(
    new Map((refundView?.standings ?? []).map((s) => [s.purchaseRecordId, s]))
  );

  /** Reads every payment's refund standing; a 403 hides the refund controls, never the list. */
  async function loadRefunds() {
    try {
      refundView = await listAssociationRefunds(asso.id);
    } catch (e) {
      refundView = null;
      if (refusalStatus(e) === 403) {
        Log.d('ASSO', 'refunds hidden: not a payout manager of this association');
      } else {
        console.error('[ASSO] loading the refunds failed:', e);
      }
    }
  }

  /** After a refund or a check: the payments and their refund states are read again. */
  async function reloadAfterRefund() {
    await Promise.all([loadPurchases(), loadRefunds()]);
  }

  /** Downloads the association's statement (payments, refunds, totals) as a spreadsheet file. */
  async function downloadStatement() {
    statementBusy = true;
    statementError = '';
    try {
      const statement = await getAssociationStatement(asso.id);
      const blob = new Blob([statementCsv(statement)], { type: 'text/csv;charset=utf-8' });
      const name = `${m.asso_statement_file()}-${asso.name}`.replace(/[\\/:*?"<>|]+/g, '_');
      await downloadDecryptedFile(blob, `${name}.csv`);
      Log.i('ASSO', `statement downloaded for ${asso.id.slice(0, 8)}`);
    } catch (e) {
      console.error('[ASSO] downloading the statement failed:', e);
      statementError = m.asso_statement_error();
    } finally {
      statementBusy = false;
    }
  }

  $effect(() => {
    const userId = grantUserId.trim();
    const productId = grantProductId;
    // Bumped BEFORE the early return: clearing a field must also void an answer still in flight.
    const seq = ++quoteSeq;
    grantQuote = null;
    if (!userId || !productId) return;
    void loadQuote(userId, productId, seq);
  });

  /**
   * Asks the server what a cash sale of `productId` to `userId` records by default; the answer is
   * shown only while `seq` is still the latest selection.
   */
  async function loadQuote(userId: string, productId: string, seq: number) {
    Log.d('ASSO', `quoting a cash sale of product ${productId.slice(0, 8)}`);
    try {
      const quote = await quoteCashSale(asso.id, productId, userId);
      if (seq !== quoteSeq) return;
      grantQuote = quote;
    } catch (e) {
      // The amount field stays open, so the cashier can still type what was paid.
      console.error(`[ASSO] quoting a cash sale of product ${productId.slice(0, 8)} failed:`, e);
    }
  }

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
      purchasesError = m.common_load_error();
    } finally {
      purchasesLoading = false;
    }
  }

  /** Maps a payment method identifier to its display label. */
  function paymentMethodLabel(method: AssociationPurchase['paymentMethod']): string {
    if (method === 'cash') return m.asso_achats_payment_cash();
    if (method === 'online' || method === 'stripe') return m.asso_achats_payment_online();
    return method;
  }

  /** The amount of a purchase as the table shows it. */
  function amountLabel(purchase: AssociationPurchase): string {
    return formatAmount(purchase.amountCents);
  }

  /**
   * Records how a payment paid for and not granted was settled, after an in-app confirmation. The
   * server answers the updated row, which replaces this one: the mark stays, the outcome shows.
   * `granted` grants the tier by hand on the server, replacing whatever tier the buyer holds now -
   * unless the row is `delivered` (the tier is already held as this payment's delivery), when it only
   * records that, and its confirmation says so.
   *
   * A 409 is an ANSWER about the row as the server knows it (closed meanwhile, its buyer erased, its
   * tier gone): the list is re-read so it shows that state, then the refusal is worded. Anything
   * else is a failure, logged as one.
   */
  async function handleClose(purchase: AssociationPurchase, outcome: PurchaseClosingOutcome) {
    const buyer = purchaseBuyerName(purchase);
    const confirmed = await showConfirm(
      outcome === 'refunded'
        ? m.asso_achats_close_refunded_confirm({ buyer, amount: amountLabel(purchase) })
        : purchase.delivered
          ? m.asso_achats_close_delivered_confirm({ buyer, item: purchase.productName })
          : m.asso_achats_close_granted_confirm({ buyer, item: purchase.productName }),
      {
        confirmLabel:
          outcome === 'refunded'
            ? m.asso_achats_close_refunded_button()
            : m.asso_achats_close_granted_button(),
      }
    );
    if (!confirmed) return;
    closingId = purchase.id;
    purchasesError = '';
    try {
      const row = await closePaidNotGranted(
        asso.id,
        purchase.id,
        outcome,
        purchase.delivered === true
      );
      purchases = purchases.map((p) => (p.id === row.id ? row : p));
      Log.i('ASSO', `purchase ${purchase.id.slice(0, 8)} closed as ${outcome}`);
    } catch (e) {
      if (refusalStatus(e) === 409) {
        Log.i(
          'ASSO',
          `closing purchase ${purchase.id.slice(0, 8)} as ${outcome} refused (${refusalCode(e)}) - re-reading the list`
        );
        await loadPurchases();
      } else {
        console.error(
          `[ASSO] closing purchase ${purchase.id.slice(0, 8)} as ${outcome} failed:`,
          e
        );
      }
      purchasesError = closingRefusalMessage(e);
    } finally {
      closingId = null;
    }
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
        // A typed amount is always sent: it is how the cashier overrides the quoted default.
        ...(grantAmountEuros !== ''
          ? { amountCents: Math.round(Number(grantAmountEuros) * 100) }
          : {}),
      });
      grantUserId = '';
      grantProductId = '';
      grantAmountEuros = '';
      await loadPurchases();
    } catch (e) {
      // A typed refusal (an amount out of the product's bounds, cotisations disabled, a tier not
      // a rise...) is worded from its code; the log names that code, never a guessed cause.
      const refusal = providerRefusalMessage(e);
      const code = e instanceof SocialApiError ? e.code : null;
      Log.i('ASSO', `cash grant refused: ${refusal ? `code=${code}` : String(e)}`);
      purchasesError = refusal ?? m.common_load_error();
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
      <Picker
        id="purchase-filter"
        value={purchaseFilterProductId}
        options={filterOptions}
        onValueChange={(v) => (purchaseFilterProductId = v)}
        label={m.asso_achats_filter_label()}
        variant="field"
        density="compact"
      />
    </div>
  </div>

  <form
    class="border-cn-border bg-cn-bg space-y-4 rounded-xl border p-4"
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
        <Picker
          id="grant-product"
          value={grantProductId}
          options={grantProductOptions}
          onValueChange={(v) => (grantProductId = v)}
          label={m.asso_achats_grant_product_label()}
          placeholder={m.asso_achats_grant_product_placeholder()}
          variant="field"
          density="compact"
        />
      </div>
      {#if grantSelectedProduct}
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
            placeholder={grantQuote?.kind === 'priced'
              ? (grantQuote.amountCents / 100).toFixed(2)
              : '0.00'}
            class="border-cn-border w-full rounded-xl border bg-transparent px-3 py-2.5 text-sm"
            required={grantNeedsAmount}
          />
        </div>
      {/if}
    </div>
    <!-- The live region stays mounted so a screen reader announces each quote as it changes; a
         region inserted together with its text is not reliably announced. -->
    <div aria-live="polite">
      {#if grantQuote?.kind === 'priced'}
        <p class="text-text-main text-xs font-semibold" data-testid="grant-quote">
          {grantQuote.preferential
            ? m.asso_achats_grant_quote_preferential({
                amount: formatAmount(grantQuote.amountCents),
              })
            : m.asso_achats_grant_quote({ amount: formatAmount(grantQuote.amountCents) })}
        </p>
      {:else if grantQuote?.kind === 'not-sold'}
        <p class="text-text-muted text-xs" data-testid="grant-quote">
          {m.asso_achats_grant_quote_not_sold()}
        </p>
      {/if}
    </div>
    <p class="text-text-muted text-xs">
      {#if grantSelectedProduct?.type === 'membership'}
        {m.asso_achats_grant_cotisation_hint({ name: grantSelectedProduct.name })}
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
        <thead class="bg-cn-bg text-text-muted text-left text-xs font-bold tracking-wide uppercase">
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
            <tr class="bg-cn-bg/20 hover:bg-cn-bg">
              <td class="text-text-muted px-4 py-3 whitespace-nowrap">
                {new Date(purchase.paidAt).toLocaleString(getLocale() === 'en' ? 'en-US' : 'fr-FR')}
              </td>
              <td class="text-text-main px-4 py-3 font-medium">{purchaseBuyerName(purchase)}</td>
              <td class="text-text-main px-4 py-3">
                {purchaseItemLabel(purchase, productsById)}
                {#if purchase.notGranted}
                  <span
                    class="bg-red-err/15 text-red-err ml-1 rounded-full px-2 py-0.5 text-xs font-semibold"
                    title={m.asso_achats_not_granted_hint()}
                  >
                    {m.asso_achats_not_granted()}
                  </span>
                  {#if purchase.closedOutcome}
                    <span
                      class="bg-cn-bg text-text-muted ml-1 rounded-full px-2 py-0.5 text-xs font-semibold"
                      title={purchase.closedAt
                        ? m.asso_achats_closed_hint({
                            date: new Date(purchase.closedAt).toLocaleString(
                              getLocale() === 'en' ? 'en-US' : 'fr-FR'
                            ),
                          })
                        : undefined}
                    >
                      {purchase.closedOutcome === 'refunded'
                        ? m.asso_achats_closed_refunded()
                        : m.asso_achats_closed_granted()}
                    </span>
                  {:else}
                    <!-- An erased buyer is no account: there is no tier to name, held or not. -->
                    {#if purchase.grantRefusal !== 'buyer-erased'}
                      <span class="text-text-muted mt-1 block text-xs">
                        {purchase.buyerTier
                          ? m.asso_achats_buyer_tier({ tier: purchase.buyerTier })
                          : m.asso_achats_buyer_tier_none()}
                      </span>
                    {/if}
                    {#if purchase.grantRefusal}
                      <span class="text-text-muted mt-1 block text-xs">
                        {grantRefusalMessage(purchase.grantRefusal)}
                      </span>
                    {/if}
                    <span class="mt-1 flex flex-wrap gap-1">
                      <button
                        type="button"
                        disabled={closingId === purchase.id}
                        onclick={() => handleClose(purchase, 'refunded')}
                        class="border-cn-border text-text-main hover:bg-cn-bg rounded-full border px-2 py-0.5 text-xs font-semibold disabled:opacity-50"
                      >
                        {m.asso_achats_close_refunded_button()}
                      </button>
                      <!-- The server refuses such a grant: only a refund can close it. -->
                      {#if !purchase.grantRefusal}
                        <button
                          type="button"
                          disabled={closingId === purchase.id}
                          onclick={() => handleClose(purchase, 'granted')}
                          class="border-cn-border text-text-main hover:bg-cn-bg rounded-full border px-2 py-0.5 text-xs font-semibold disabled:opacity-50"
                        >
                          {m.asso_achats_close_granted_button()}
                        </button>
                      {/if}
                    </span>
                  {/if}
                {/if}
              </td>
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
                {amountLabel(purchase)}
                {#if refundView}
                  {@const standing = standingsById.get(purchase.id)}
                  {@const stateLabel = refundStateLabel(standing)}
                  {@const waiting = unconfirmedRefund(standing, refundView.refunds)}
                  {@const hint = notRefundableHint(standing)}
                  {#if stateLabel}
                    <span
                      class="text-text-muted mt-1 block text-xs font-semibold"
                      data-testid="refund-state">{stateLabel}</span
                    >
                  {/if}
                  {#if waiting}
                    <button
                      type="button"
                      onclick={() =>
                        (checkTarget = { refund: waiting, buyer: purchaseBuyerName(purchase) })}
                      class="border-cn-border text-text-main hover:bg-cn-bg mt-1 rounded-full border px-2 py-0.5 text-xs font-semibold"
                    >
                      {m.asso_refund_check_button()}
                    </button>
                  {:else if standing?.refundable && standing.refundedCents < standing.paidCents}
                    <button
                      type="button"
                      onclick={() => (refundTarget = purchase)}
                      data-testid="refund-open"
                      class="border-cn-border text-text-main hover:bg-cn-bg mt-1 rounded-full border px-2 py-0.5 text-xs font-semibold"
                    >
                      {m.asso_refund_button()}
                    </button>
                  {:else if hint}
                    <span class="text-text-muted mt-1 block text-xs font-normal">{hint}</span>
                  {/if}
                {/if}
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

  {#if refundView}
    <div class="border-cn-border flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center">
      <p class="text-text-muted flex-1 text-xs">{m.asso_statement_hint()}</p>
      <button
        type="button"
        disabled={statementBusy}
        onclick={downloadStatement}
        class="border-cn-border text-text-main hover:bg-cn-bg rounded-xl border px-4 py-2 text-sm font-semibold disabled:opacity-50"
      >
        {m.asso_statement_button()}
      </button>
    </div>
    {#if statementError}
      <p class="text-red-err text-xs" role="alert">{statementError}</p>
    {/if}
  {/if}
</div>

{#if refundTarget}
  {@const target = refundTarget}
  {@const standing = standingsById.get(target.id)}
  {#if standing}
    <RefundDialog
      associationId={asso.id}
      purchase={target}
      {standing}
      buyer={purchaseBuyerName(target)}
      item={purchaseItemLabel(target, productsById)}
      onClose={() => (refundTarget = null)}
      onSettled={reloadAfterRefund}
    />
  {/if}
{/if}

{#if checkTarget}
  <RefundCheckDialog
    associationId={asso.id}
    refund={checkTarget.refund}
    buyer={checkTarget.buyer}
    onClose={() => (checkTarget = null)}
    onSettled={reloadAfterRefund}
  />
{/if}
