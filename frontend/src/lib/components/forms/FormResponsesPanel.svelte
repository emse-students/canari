<script lang="ts">
  import { Search } from '@lucide/svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import RefundDialog from '$lib/components/associations/edit/RefundDialog.svelte';
  import FormSubmissionsTable from './FormSubmissionsTable.svelte';
  import {
    fileAnswerWords,
    validateCashSubmission,
    type Form,
    type Submission,
  } from '$lib/forms/api';
  import {
    listAssociationPurchases,
    listAssociationRefunds,
    type AssociationPurchase,
    type RefundStanding,
  } from '$lib/associations/api';
  import {
    RESPONSE_FILTERS,
    choiceResults,
    filterCounts,
    gridTotalsViews,
    productGridQuestions,
    responsesSummary,
    visibleResponses,
    type ResponseFilter,
  } from '$lib/forms/responsesView';
  import { productGridCellKey } from '$lib/forms/productGridContract';
  import { submitterName } from '$lib/forms/submissionTable';
  import { formatAmount } from '$lib/forms/fillAnswers';
  import { refusalStatus } from '$lib/utils/apiRefusal';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';

  /**
   * ONE FORM'S RESPONSES SCREEN (WP-G4, the owner-approved mockup of 2026-11-06): summary cards, then
   * three tabs - "Réponses" (search, payment filters, the table and its actions), "Totaux" (a priced
   * grid's order, row x column) and "Résumé" (a bar per option of each choice question).
   *
   * Everything is derived from the answers the list already loaded (`getSubmissions`); the rules
   * live in `responsesView.ts`, and the grid totals in the contract the export shares. The two
   * payment actions are the existing flows, nothing new: "Marquer payé" is the cash validation
   * (`validate-cash`), "Rembourser" the association's refund dialog, opened on the payment that paid
   * this answer (`AssociationPurchase.submissionId`).
   *
   * THE "RÉSUMÉ" TAB IS FOR MANAGERS ONLY (owner): this whole screen is - `getSubmissions` answers a
   * form manager and nobody else - and it says so above the bars.
   */
  interface Props {
    form: Form;
    submissions: Submission[];
    /** The submission currently being deleted, so its control can say so. */
    deletingId: string | null;
    onDelete: (sub: Submission) => void;
    /** Re-reads the answers once a payment action settled, so every card and tab follows. */
    onReload: () => Promise<void>;
  }

  let { form, submissions, deletingId, onDelete, onReload }: Props = $props();

  const anonymous = $derived(form.anonymous ?? false);
  const requiresPayment = $derived(form.requiresPayment ?? false);
  const items = $derived(form.items ?? []);
  const grids = $derived(productGridQuestions(items));
  const summary = $derived(
    responsesSummary(submissions, anonymous, (sub) => {
      const purchase = refunds?.purchaseBySubmission.get(sub.id);
      return (purchase && refunds?.standingByPurchase.get(purchase.id)?.refundedCents) || 0;
    })
  );
  const counts = $derived(filterCounts(submissions));

  type Tab = 'list' | 'totals' | 'summary';
  let tab = $state<Tab>('list');
  let filter = $state<ResponseFilter>('all');
  let query = $state('');
  /** The owner's switch: cash not yet received is counted unless a manager leaves it out. */
  let withUnpaid = $state(true);

  const words = $derived(fileAnswerWords(submissions));
  const shown = $derived(visibleResponses(submissions, items, filter, query, words, anonymous));
  const totals = $derived(gridTotalsViews(items, submissions, withUnpaid));
  const grandUnits = $derived(totals.reduce((sum, view) => sum + view.totals.total.units, 0));
  const grandCents = $derived(totals.reduce((sum, view) => sum + view.totals.total.cents, 0));
  const choices = $derived(choiceResults(items, submissions));

  const tabs = $derived([
    { key: 'list' as const, label: m.form_responses_tab_list() },
    ...(grids.length ? [{ key: 'totals' as const, label: m.form_responses_tab_totals() }] : []),
    ...(choices.length || grids.length
      ? [{ key: 'summary' as const, label: m.form_responses_tab_summary() }]
      : []),
  ]);

  const filterLabels: Record<ResponseFilter, () => string> = {
    all: () => m.form_responses_filter_all(),
    paid: () => m.form_responses_filter_paid(),
    unpaid: () => m.form_responses_filter_unpaid(),
    refunded: () => m.form_responses_filter_refunded(),
  };

  function units(count: number): string {
    return m.form_responses_units({ count });
  }

  // ── Refunds, through the association's existing flow ───────────────────────────────────────────

  /**
   * The payment behind each answer, and its refund standing - read only for an association's paid
   * form. Null when not loaded, or when this manager may not refund (the purchases list asks
   * MANAGE_PRODUCTS, the refunds MANAGE_PAYOUT_ACCOUNT): a 403 hides the control, never the list.
   */
  let refunds = $state<{
    purchaseBySubmission: Map<string, AssociationPurchase>;
    standingByPurchase: Map<string, RefundStanding>;
  } | null>(null);
  let refundTarget = $state<{ sub: Submission; purchase: AssociationPurchase } | null>(null);

  async function loadRefunds(associationId: string) {
    try {
      const [purchases, view] = await Promise.all([
        listAssociationPurchases(associationId),
        listAssociationRefunds(associationId),
      ]);
      // Replaced whole on every read, never mutated: a plain Map is the state's value, not its store.
      const purchaseBySubmission = new Map(
        purchases
          .filter((purchase) => purchase.formId === form.id && purchase.submissionId)
          .map((purchase) => [purchase.submissionId as string, purchase] as const)
      );
      refunds = {
        purchaseBySubmission,
        standingByPurchase: new Map(view.standings.map((s) => [s.purchaseRecordId, s])),
      };
      Log.d('FormResponsesPanel', `refunds: ${purchaseBySubmission.size} payments of this form`);
    } catch (e) {
      refunds = null;
      if (refusalStatus(e) === 403) {
        Log.d('FormResponsesPanel', 'refunds hidden: not a payout manager of this association');
      } else {
        console.error('[FORMS] loading the refunds of a form failed:', e);
      }
    }
  }

  $effect(() => {
    const associationId = form.associationId;
    if (!associationId || !requiresPayment) return;
    void loadRefunds(associationId);
  });

  /** The payment a refund of this answer would go back on, when one is offered. */
  function refundablePayment(sub: Submission): AssociationPurchase | null {
    if (sub.paymentStatus !== 'paid' && sub.paymentStatus !== 'paid_over_capacity') return null;
    const purchase = refunds?.purchaseBySubmission.get(sub.id);
    const standing = purchase && refunds?.standingByPurchase.get(purchase.id);
    if (!purchase || !standing) return null;
    if (!standing.refundable || standing.openRefund) return null;
    return standing.refundedCents < standing.paidCents ? purchase : null;
  }

  async function afterRefund() {
    await onReload();
    if (form.associationId) await loadRefunds(form.associationId);
  }

  // ── Cash, marked paid ──────────────────────────────────────────────────────────────────────────

  let markingId = $state<string | null>(null);

  async function markPaid(sub: Submission) {
    const name = anonymous ? '' : submitterName(sub);
    if (
      !(await showConfirm(
        m.form_responses_mark_paid_confirm({ name, amount: formatAmount(sub.totalPaid) }),
        { confirmLabel: m.form_responses_mark_paid() }
      ))
    )
      return;
    markingId = sub.id;
    Log.d('FormResponsesPanel', `marking cash answer ${sub.id.slice(0, 8)} paid`);
    try {
      await validateCashSubmission(form.id, sub.id);
      await onReload();
    } catch (e) {
      console.error(`[FORMS] marking cash answer ${sub.id.slice(0, 8)} paid failed:`, e);
      showToast(m.form_responses_mark_paid_error());
    } finally {
      markingId = null;
    }
  }
</script>

{#snippet card(label: string, value: string, hint: string | null, tone: string = '')}
  <div class="bg-cn-surface-alt flex flex-col gap-1 rounded-2xl px-5 py-4">
    <span class="text-text-muted text-xs font-bold">{label}</span>
    <span class="text-2xl font-bold {tone || 'text-text-main'}">{value}</span>
    {#if hint}<span class="text-text-muted text-xs">{hint}</span>{/if}
  </div>
{/snippet}

{#snippet rowActions(sub: Submission)}
  {#if sub.paymentStatus === 'pending_cash'}
    <button
      type="button"
      onclick={() => void markPaid(sub)}
      disabled={markingId === sub.id}
      class="border-cn-border text-text-main hover:bg-control-fill rounded-full border px-2.5 py-1 text-xs font-bold whitespace-nowrap disabled:opacity-50"
      data-testid="mark-paid"
    >
      {m.form_responses_mark_paid()}
    </button>
  {/if}
  {@const payment = refundablePayment(sub)}
  {#if payment}
    <button
      type="button"
      onclick={() => (refundTarget = { sub, purchase: payment })}
      class="border-cn-border text-text-main hover:bg-control-fill rounded-full border px-2.5 py-1 text-xs font-bold whitespace-nowrap"
      data-testid="refund-open"
    >
      {m.asso_refund_button()}
    </button>
  {/if}
{/snippet}

<div class="flex flex-col gap-4" data-testid="form-responses">
  <!-- The summary cards. The three money cards only on a paid form: on a free one they would read
       0 down the row. -->
  <div class="grid grid-cols-[repeat(auto-fit,minmax(min(12rem,100%),1fr))] gap-3">
    {@render card(
      m.form_responses_card_answers(),
      String(summary.answers),
      summary.guests ? m.form_responses_card_guests({ count: summary.guests }) : null
    )}
    {#if requiresPayment}
      {@render card(
        m.form_responses_card_paid(),
        String(summary.paid),
        m.form_responses_card_paid_hint()
      )}
      {@render card(
        m.form_responses_card_unpaid(),
        String(summary.unpaidCash),
        m.form_responses_card_unpaid_hint({ amount: formatAmount(summary.unpaidCashCents) }),
        summary.unpaidCash ? 'text-amber-warn-text' : ''
      )}
      {@render card(
        m.form_responses_card_collected(),
        formatAmount(summary.collectedCents),
        summary.refundedCents
          ? m.form_responses_card_refunded_hint({ amount: formatAmount(summary.refundedCents) })
          : refunds === null && form.associationId && summary.paid
            ? m.form_responses_card_collected_gross_hint()
            : null
      )}
    {/if}
  </div>

  {#if tabs.length > 1}
    <SegmentedControl
      items={tabs}
      value={tab}
      onSelect={(key) => (tab = key)}
      label={m.form_responses_tabs_label()}
      tone="yellow"
      variant="underline"
      idPrefix="form-{form.id}-"
    />
  {/if}

  {#if tab === 'list'}
    <div class="flex flex-col gap-3" role="tabpanel" id="form-{form.id}-tabpanel-list">
      <div class="flex flex-wrap items-center gap-2">
        <label
          class="bg-control-fill flex min-h-11 flex-[1_1_16rem] items-center gap-2 rounded-full px-3.5"
        >
          <Search size={16} class="text-text-muted shrink-0" />
          <span class="sr-only">{m.form_responses_search()}</span>
          <input
            type="search"
            bind:value={query}
            placeholder={m.form_responses_search()}
            class="min-h-10 min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
            data-testid="responses-search"
          />
        </label>
        {#if requiresPayment}
          <div
            class="flex flex-wrap gap-1.5"
            role="group"
            aria-label={m.form_responses_filters_label()}
          >
            {#each RESPONSE_FILTERS as key (key)}
              <button
                type="button"
                onclick={() => (filter = key)}
                aria-pressed={filter === key}
                class="min-h-10 rounded-full border px-3.5 text-sm font-bold transition-colors {filter ===
                key
                  ? 'bg-cn-ink border-cn-ink text-white'
                  : 'border-cn-border text-text-main bg-(--cn-surface)'}"
                data-testid="filter-{key}"
              >
                {filterLabels[key]()} · {counts[key]}
              </button>
            {/each}
          </div>
        {/if}
      </div>
      {#if shown.length === 0}
        <p class="text-text-muted py-4 text-center text-sm" data-testid="responses-no-match">
          {m.form_responses_no_match()}
        </p>
      {:else}
        <FormSubmissionsTable
          formId={form.id}
          {items}
          {requiresPayment}
          {anonymous}
          submissions={shown}
          {deletingId}
          {onDelete}
          {rowActions}
        />
      {/if}
    </div>
  {:else if tab === 'totals'}
    <div class="flex flex-col gap-3" role="tabpanel" id="form-{form.id}-tabpanel-totals">
      <div
        class="bg-cn-surface-alt flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3"
      >
        <div>
          <p class="text-text-muted text-xs font-bold">{m.form_responses_totals_all()}</p>
          <p class="text-text-main text-xl font-bold" data-testid="grand-units">
            {units(grandUnits)} · {formatAmount(grandCents)}
          </p>
        </div>
        <Toggle
          bind:checked={withUnpaid}
          label={m.form_responses_count_unpaid()}
          hint={m.form_responses_count_unpaid_hint()}
        />
      </div>
      {#each totals as view (view.item.id)}
        {@const closed = new Set(view.item.productGrid.closedCells ?? [])}
        <section class="border-cn-border rounded-2xl border p-4" data-testid="grid-totals">
          <header class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h3 class="text-text-main font-bold whitespace-pre-line">{view.item.label}</h3>
            <span class="text-text-muted text-sm font-semibold">
              {units(view.totals.total.units)} · {formatAmount(view.totals.total.cents)}
            </span>
          </header>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-text-muted text-xs font-bold">
                  <th class="py-1.5 pr-3 text-left"></th>
                  {#each view.totals.columns as col (col.id)}
                    <th class="px-2 py-1.5 text-center">{col.label}</th>
                  {/each}
                  <th class="px-2 py-1.5 text-center">{m.form_responses_total()}</th>
                </tr>
              </thead>
              <tbody>
                {#each view.totals.rows as row, index (row.id)}
                  <tr class={index % 2 === 0 ? 'bg-cn-surface-alt' : ''}>
                    <th class="text-text-main py-1.5 pr-3 text-left font-semibold">{row.label}</th>
                    {#each view.totals.columns as col (col.id)}
                      {@const key = productGridCellKey(row.id, col.id)}
                      {@const value = view.totals.cells[key]?.units ?? 0}
                      <td class="px-2 py-1.5 text-center tabular-nums">
                        {#if closed.has(key) && value === 0}
                          <span class="text-text-muted line-through">{col.label}</span>
                        {:else}
                          <span
                            class={value > 0 ? 'text-text-main font-bold' : 'text-text-muted'}
                            data-testid="cell-{key}">{value}</span
                          >
                        {/if}
                      </td>
                    {/each}
                    <td class="text-text-main px-2 py-1.5 text-center font-bold tabular-nums">
                      {view.totals.rowTotals[row.id].units}
                    </td>
                  </tr>
                {/each}
              </tbody>
              <tfoot>
                <tr class="border-cn-border border-t font-bold">
                  <th class="text-text-main py-1.5 pr-3 text-left">{m.form_responses_total()}</th>
                  {#each view.totals.columns as col (col.id)}
                    <td class="text-text-main px-2 py-1.5 text-center tabular-nums">
                      {view.totals.columnTotals[col.id].units}
                    </td>
                  {/each}
                  <td class="text-text-main px-2 py-1.5 text-center tabular-nums">
                    {view.totals.total.units}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      {/each}
    </div>
  {:else}
    <div class="flex flex-col gap-3" role="tabpanel" id="form-{form.id}-tabpanel-summary">
      <p class="text-text-muted text-xs">{m.form_responses_summary_managers_only()}</p>
      {#each choices as result (result.item.id)}
        {@const max = Math.max(1, ...result.bars.map((bar) => bar.count))}
        <section class="border-cn-border rounded-2xl border p-4" data-testid="choice-result">
          <h3 class="text-text-main font-bold whitespace-pre-line">{result.item.label}</h3>
          <p class="text-text-muted mb-3 text-xs">
            {m.form_responses_summary_answers({ count: result.answered })}
          </p>
          <ul class="flex flex-col gap-2">
            {#each result.bars as bar, index (index)}
              <li class="grid grid-cols-[minmax(0,12rem)_1fr_auto] items-center gap-3 text-sm">
                <span class="text-text-main truncate" title={bar.label}>{bar.label}</span>
                <span class="bg-control-fill h-2.5 overflow-hidden rounded-full">
                  <span
                    class="bg-accent block h-full rounded-full"
                    style:width="{Math.round((100 * bar.count) / max)}%"
                  ></span>
                </span>
                <span class="text-text-muted text-xs font-semibold tabular-nums">
                  {bar.count} · {bar.percent} %
                </span>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
      {#if grids.length}
        {@const max = Math.max(1, ...totals.map((view) => view.totals.total.units))}
        <section class="border-cn-border rounded-2xl border p-4">
          <h3 class="text-text-main font-bold">{m.form_responses_summary_units_chart()}</h3>
          <p class="text-text-muted mb-3 text-xs">{units(grandUnits)}</p>
          <ul class="flex flex-col gap-2">
            {#each totals as view (view.item.id)}
              <li class="grid grid-cols-[minmax(0,12rem)_1fr_auto] items-center gap-3 text-sm">
                <span class="text-text-main truncate" title={view.item.label}
                  >{view.item.label}</span
                >
                <span class="bg-control-fill h-2.5 overflow-hidden rounded-full">
                  <span
                    class="bg-accent block h-full rounded-full"
                    style:width="{Math.round((100 * view.totals.total.units) / max)}%"
                  ></span>
                </span>
                <span class="text-text-muted text-xs font-semibold tabular-nums">
                  {view.totals.total.units}
                </span>
              </li>
            {/each}
          </ul>
        </section>
      {:else if choices.length === 0}
        <p class="text-text-muted text-sm">{m.form_responses_summary_empty()}</p>
      {/if}
    </div>
  {/if}
</div>

{#if refundTarget && form.associationId}
  {@const target = refundTarget}
  {@const standing = refunds?.standingByPurchase.get(target.purchase.id)}
  {#if standing}
    <RefundDialog
      associationId={form.associationId}
      purchase={target.purchase}
      {standing}
      buyer={anonymous ? '' : submitterName(target.sub)}
      item={form.title}
      onClose={() => (refundTarget = null)}
      onSettled={() => void afterRefund()}
    />
  {/if}
{/if}
