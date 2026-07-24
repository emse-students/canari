<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listAssociations,
    getPaymentDelegation,
    requestPaymentDelegation,
    cancelPaymentDelegation,
    listDelegatedChildren,
    approveDelegatedChild,
    rejectDelegatedChild,
    listChildPurchases,
    exportChildPurchases,
    type Association,
    type PaymentDelegationState,
    type DelegatedChild,
    type AssociationPurchase,
  } from '$lib/associations/api';
  import {
    Share2,
    Inbox,
    Check,
    X,
    Download,
    ChevronDown,
    ChevronUp,
    AlertTriangle,
  } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
  import { SvelteSet } from 'svelte/reactivity';

  interface Props {
    asso: Association;
  }

  let { asso }: Props = $props();

  let loading = $state(true);
  let error = $state('');

  // Club-side (this association delegating to a parent).
  let delegation = $state<PaymentDelegationState | null>(null);
  let associations = $state<Association[]>([]);
  let selectedParentId = $state('');
  let requesting = $state(false);
  let cancelling = $state(false);

  // Parent-side (this association receiving delegated payments).
  let children = $state<DelegatedChild[]>([]);
  /** Per-child accounting rows, loaded lazily on expand. */
  let childPurchases = $state<Record<string, AssociationPurchase[]>>({});
  let expandedChildId = $state<string | null>(null);
  let childLoading = $state<string | null>(null);
  /** Set of child ids with an approve/reject/export in flight. */
  const busyChildIds = new SvelteSet<string>();

  /** True when this association already receives delegated payments and so cannot delegate its own. */
  const isParent = $derived(children.length > 0);
  /** Parent-side approvals require this association's own Stripe Connect to be ready. */
  const canReceiveDelegation = $derived(asso.stripeOnboardingComplete === true);
  /** Candidate parents: every other regular association (server enforces chain/parent rules). */
  const parentCandidates = $derived(associations.filter((a) => a.id !== asso.id));

  onMount(loadAll);

  async function loadAll() {
    loading = true;
    error = '';
    try {
      const [state, kids, assos] = await Promise.all([
        getPaymentDelegation(asso.id),
        listDelegatedChildren(asso.id),
        listAssociations('association'),
      ]);
      delegation = state;
      children = kids;
      associations = assos;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Error';
    } finally {
      loading = false;
    }
  }

  async function handleRequest() {
    if (!selectedParentId) return;
    requesting = true;
    error = '';
    try {
      delegation = await requestPaymentDelegation(asso.id, selectedParentId);
      selectedParentId = '';
    } catch (e) {
      error = e instanceof Error ? e.message : 'Error';
    } finally {
      requesting = false;
    }
  }

  async function handleCancel() {
    cancelling = true;
    error = '';
    try {
      delegation = await cancelPaymentDelegation(asso.id);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Error';
    } finally {
      cancelling = false;
    }
  }

  function setChildBusy(childId: string, busy: boolean) {
    if (busy) busyChildIds.add(childId);
    else busyChildIds.delete(childId);
  }

  async function handleApprove(childId: string) {
    setChildBusy(childId, true);
    error = '';
    try {
      await approveDelegatedChild(asso.id, childId);
      children = await listDelegatedChildren(asso.id);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Error';
    } finally {
      setChildBusy(childId, false);
    }
  }

  async function handleReject(childId: string) {
    setChildBusy(childId, true);
    error = '';
    try {
      await rejectDelegatedChild(asso.id, childId);
      children = await listDelegatedChildren(asso.id);
      if (expandedChildId === childId) expandedChildId = null;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Error';
    } finally {
      setChildBusy(childId, false);
    }
  }

  async function toggleAccounting(childId: string) {
    if (expandedChildId === childId) {
      expandedChildId = null;
      return;
    }
    expandedChildId = childId;
    if (childPurchases[childId]) return;
    childLoading = childId;
    error = '';
    try {
      childPurchases = { ...childPurchases, [childId]: await listChildPurchases(asso.id, childId) };
    } catch (e) {
      error = e instanceof Error ? e.message : 'Error';
      expandedChildId = null;
    } finally {
      childLoading = null;
    }
  }

  async function handleExportChild(childId: string) {
    setChildBusy(childId, true);
    error = '';
    try {
      await exportChildPurchases(asso.id, childId);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Error';
    } finally {
      setChildBusy(childId, false);
    }
  }

  function buyerName(p: AssociationPurchase): string {
    if (p.firstName || p.lastName) return `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim();
    return getUserDisplayNameSync(p.userId);
  }

  function paymentMethodLabel(method: AssociationPurchase['paymentMethod']): string {
    if (method === 'cash') return m.asso_achats_payment_cash();
    if (method === 'stripe') return m.asso_achats_payment_stripe();
    return method;
  }
</script>

<div class="space-y-6">
  {#if error}
    <div class="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">
      {error}
    </div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-12">
      <div
        class="h-6 w-6 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
      ></div>
    </div>
  {:else}
    <!-- Club-side: delegate this association's payments to a parent. -->
    <section
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-4 shadow-sm"
    >
      <div>
        <h2 class="text-lg font-bold text-text-main tracking-tight flex items-center gap-2">
          <Share2 size={20} />
          {m.asso_deleg_club_title()}
        </h2>
        <p class="text-sm text-text-muted mt-1">{m.asso_deleg_club_desc()}</p>
      </div>

      {#if isParent}
        <p class="rounded-xl border border-cn-border bg-cn-bg/40 px-4 py-3 text-sm text-text-muted">
          {m.asso_deleg_is_parent_note()}
        </p>
      {:else if delegation?.status === 'pending'}
        <div
          class="rounded-xl border border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100 px-4 py-3 space-y-1"
        >
          <p class="text-sm font-semibold">{m.asso_deleg_status_pending_title()}</p>
          <p class="text-sm leading-relaxed">
            {m.asso_deleg_status_pending_desc({ parent: delegation.parentName ?? '' })}
          </p>
        </div>
        <button
          type="button"
          onclick={() => void handleCancel()}
          disabled={cancelling}
          class="rounded-xl border border-cn-border px-4 py-2 text-sm font-semibold text-text-muted hover:text-text-main hover:bg-cn-bg disabled:opacity-50"
        >
          {cancelling ? m.asso_deleg_cancelling() : m.asso_deleg_cancel_button()}
        </button>
      {:else if delegation?.status === 'approved'}
        <div
          class="rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100 px-4 py-3 space-y-1"
        >
          <p class="text-sm font-semibold">{m.asso_deleg_status_approved_title()}</p>
          <p class="text-sm leading-relaxed">
            {m.asso_deleg_status_approved_desc({ parent: delegation.parentName ?? '' })}
          </p>
        </div>
        {#if !delegation.parentReady}
          <p class="flex items-start gap-2 text-sm text-amber-700">
            <AlertTriangle size={16} class="mt-0.5 shrink-0" />
            {m.asso_deleg_parent_not_ready()}
          </p>
        {/if}
        <button
          type="button"
          onclick={() => void handleCancel()}
          disabled={cancelling}
          class="rounded-xl border border-cn-border px-4 py-2 text-sm font-semibold text-text-muted hover:text-text-main hover:bg-cn-bg disabled:opacity-50"
        >
          {cancelling ? m.asso_deleg_cancelling() : m.asso_deleg_cancel_button()}
        </button>
      {:else}
        <div class="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div>
            <label for="deleg-parent" class="text-xs font-semibold text-text-muted block mb-1">
              {m.asso_deleg_select_label()}
            </label>
            <select
              id="deleg-parent"
              bind:value={selectedParentId}
              class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2.5 text-sm"
            >
              <option value="">{m.asso_deleg_select_placeholder()}</option>
              {#each parentCandidates as candidate (candidate.id)}
                <option value={candidate.id}>{candidate.name}</option>
              {/each}
            </select>
          </div>
          <button
            type="button"
            onclick={() => void handleRequest()}
            disabled={requesting || !selectedParentId}
            class="rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
          >
            {requesting ? m.asso_deleg_requesting() : m.asso_deleg_request_button()}
          </button>
        </div>
      {/if}
    </section>

    <!-- Parent-side: incoming delegation requests and approved children accounting. -->
    <section
      class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-4 shadow-sm"
    >
      <div>
        <h2 class="text-lg font-bold text-text-main tracking-tight flex items-center gap-2">
          <Inbox size={20} />
          {m.asso_deleg_parent_title()}
        </h2>
        <p class="text-sm text-text-muted mt-1">{m.asso_deleg_parent_desc()}</p>
      </div>

      {#if !canReceiveDelegation}
        <p class="flex items-start gap-2 text-sm text-amber-700">
          <AlertTriangle size={16} class="mt-0.5 shrink-0" />
          {m.asso_deleg_parent_not_stripe_ready()}
        </p>
      {/if}

      {#if children.length === 0}
        <p class="text-sm text-text-muted text-center py-6">{m.asso_deleg_queue_empty()}</p>
      {:else}
        <ul class="space-y-3">
          {#each children as child (child.associationId)}
            <li class="rounded-xl border border-cn-border/70 bg-cn-bg/30 p-4 space-y-3">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="flex items-center gap-2">
                  <span class="font-semibold text-text-main">{child.name}</span>
                  <span
                    class="rounded-full px-2 py-0.5 text-xs font-semibold {child.status ===
                    'approved'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-amber-100 text-amber-700'}"
                  >
                    {child.status === 'approved'
                      ? m.asso_deleg_child_approved_badge()
                      : m.asso_deleg_child_pending_badge()}
                  </span>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  {#if child.status === 'pending'}
                    <button
                      type="button"
                      onclick={() => void handleApprove(child.associationId)}
                      disabled={busyChildIds.has(child.associationId) || !canReceiveDelegation}
                      class="inline-flex items-center gap-1.5 rounded-lg bg-cn-yellow px-3 py-1.5 text-xs font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
                    >
                      <Check size={14} />
                      {m.asso_deleg_approve_button()}
                    </button>
                    <button
                      type="button"
                      onclick={() => void handleReject(child.associationId)}
                      disabled={busyChildIds.has(child.associationId)}
                      class="inline-flex items-center gap-1.5 rounded-lg border border-cn-border px-3 py-1.5 text-xs font-semibold text-text-muted hover:text-red-700 disabled:opacity-50"
                    >
                      <X size={14} />
                      {m.asso_deleg_reject_button()}
                    </button>
                  {:else}
                    <button
                      type="button"
                      onclick={() => void toggleAccounting(child.associationId)}
                      class="inline-flex items-center gap-1.5 rounded-lg border border-cn-border px-3 py-1.5 text-xs font-semibold text-text-muted hover:text-text-main"
                    >
                      {#if expandedChildId === child.associationId}
                        <ChevronUp size={14} />
                        {m.asso_deleg_hide_accounting()}
                      {:else}
                        <ChevronDown size={14} />
                        {m.asso_deleg_view_accounting()}
                      {/if}
                    </button>
                    <button
                      type="button"
                      onclick={() => void handleExportChild(child.associationId)}
                      disabled={busyChildIds.has(child.associationId)}
                      class="inline-flex items-center gap-1.5 rounded-lg border border-cn-border px-3 py-1.5 text-xs font-semibold text-text-muted hover:text-text-main disabled:opacity-50"
                    >
                      <Download size={14} />
                      {m.asso_deleg_export_button()}
                    </button>
                    <button
                      type="button"
                      onclick={() => void handleReject(child.associationId)}
                      disabled={busyChildIds.has(child.associationId)}
                      class="inline-flex items-center gap-1.5 rounded-lg border border-cn-border px-3 py-1.5 text-xs font-semibold text-text-muted hover:text-red-700 disabled:opacity-50"
                    >
                      <X size={14} />
                      {m.asso_deleg_revoke_button()}
                    </button>
                  {/if}
                </div>
              </div>

              {#if expandedChildId === child.associationId}
                {#if childLoading === child.associationId}
                  <div class="flex justify-center py-6">
                    <div
                      class="h-5 w-5 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
                    ></div>
                  </div>
                {:else if (childPurchases[child.associationId]?.length ?? 0) === 0}
                  <p class="text-sm text-text-muted text-center py-4">
                    {m.asso_achats_no_purchases()}
                  </p>
                {:else}
                  <div class="overflow-x-auto rounded-lg border border-cn-border/70">
                    <table class="w-full text-sm">
                      <thead
                        class="bg-cn-bg/60 text-left text-xs font-bold uppercase tracking-wide text-text-muted"
                      >
                        <tr>
                          <th class="px-3 py-2">{m.asso_achats_col_date()}</th>
                          <th class="px-3 py-2">{m.asso_achats_col_buyer()}</th>
                          <th class="px-3 py-2">{m.asso_achats_col_item()}</th>
                          <th class="px-3 py-2">{m.asso_achats_col_payment()}</th>
                          <th class="px-3 py-2 text-right">{m.asso_achats_col_amount()}</th>
                        </tr>
                      </thead>
                      <tbody class="divide-y divide-cn-border/50">
                        {#each childPurchases[child.associationId] as purchase (purchase.id)}
                          <tr class="bg-cn-bg/20">
                            <td class="px-3 py-2 text-text-muted whitespace-nowrap">
                              {new Date(purchase.paidAt).toLocaleString(
                                getLocale() === 'en' ? 'en-US' : 'fr-FR'
                              )}
                            </td>
                            <td class="px-3 py-2 font-medium text-text-main">
                              {buyerName(purchase)}
                            </td>
                            <td class="px-3 py-2 text-text-main">{purchase.productName}</td>
                            <td class="px-3 py-2 text-text-muted">
                              {paymentMethodLabel(purchase.paymentMethod)}
                            </td>
                            <td class="px-3 py-2 text-right font-semibold tabular-nums">
                              {(purchase.amountCents / 100).toFixed(2)} €
                            </td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                {/if}
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>
