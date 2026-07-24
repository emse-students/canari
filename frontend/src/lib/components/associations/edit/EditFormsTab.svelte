<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listAssociationForms,
    type Association,
    type AssociationForm,
  } from '$lib/associations/api';
  import {
    listPendingCashSubmissions,
    validateCashSubmission,
    cancelCashSubmission,
    type PendingCashSubmission,
  } from '$lib/forms/api';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { ClipboardList, AlertTriangle } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import { getUserDisplayNameSync } from '$lib/utils/users/displayName';

  interface Props {
    asso: Association;
    /** True once Stripe Connect can collect online payments. */
    stripePaymentsReady: boolean;
    /** Whether the caller can configure Stripe Connect (tweaks the warning copy). */
    canManageStripeConnect: boolean;
    /** Switches the parent to the Paiements tab. */
    onGoToPayments: () => void;
  }

  let { asso, stripePaymentsReady, canManageStripeConnect, onGoToPayments }: Props = $props();

  let forms = $state<AssociationForm[]>([]);
  let formsLoading = $state(false);
  let formsError = $state('');
  let pendingCash = $state<Record<string, PendingCashSubmission[]>>({});
  /** True when at least one association form requires online payment (basePrice > 0). */
  let hasPaidForms = $derived(forms.some((f) => f.basePrice > 0));

  onMount(loadForms);

  async function loadForms() {
    formsLoading = true;
    formsError = '';
    try {
      forms = await listAssociationForms(asso.id);
      const cashMap: Record<string, PendingCashSubmission[]> = {};
      await Promise.all(
        forms
          .filter((f) => f.allowCashPayment)
          .map(async (f) => {
            try {
              cashMap[f.id] = await listPendingCashSubmissions(f.id);
            } catch {
              cashMap[f.id] = [];
            }
          })
      );
      pendingCash = cashMap;
    } catch (e) {
      formsError = e instanceof Error ? e.message : 'Error';
    } finally {
      formsLoading = false;
    }
  }

  async function validateCash(formId: string, subId: string) {
    try {
      await validateCashSubmission(formId, subId);
      pendingCash = {
        ...pendingCash,
        [formId]: pendingCash[formId].filter((s) => s.id !== subId),
      };
    } catch (e) {
      formsError = e instanceof Error ? e.message : 'Error';
    }
  }

  async function cancelCash(formId: string, subId: string) {
    if (
      !(await showConfirm(m.asso_forms_cancel_cash_confirm(), {
        danger: true,
        confirmLabel: m.asso_forms_cancel_cash_confirm_button(),
        cancelLabel: m.asso_forms_cancel_cash_cancel(),
      }))
    )
      return;
    try {
      await cancelCashSubmission(formId, subId);
      pendingCash = {
        ...pendingCash,
        [formId]: pendingCash[formId].filter((s) => s.id !== subId),
      };
    } catch (e) {
      formsError = e instanceof Error ? e.message : 'Error';
    }
  }
</script>

<div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 p-6 space-y-5 shadow-sm">
  <div>
    <h2 class="text-lg font-bold text-text-main tracking-tight flex items-center gap-2">
      <ClipboardList size={20} />
      {m.asso_forms_title()}
    </h2>
    <p class="text-sm text-text-muted mt-1">
      {m.asso_forms_subtitle()}
    </p>
  </div>

  {#if hasPaidForms && !stripePaymentsReady}
    <div
      class="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-800 flex items-start gap-2.5"
    >
      <AlertTriangle size={15} class="shrink-0 mt-0.5" />
      <span>
        {#if canManageStripeConnect}
          {m.asso_forms_stripe_missing_can_manage_prefix()}<strong
            >{m.asso_forms_stripe_missing_strong()}</strong
          >{m.asso_forms_stripe_missing_suffix()}<button
            type="button"
            class="underline font-semibold hover:no-underline"
            onclick={onGoToPayments}>{m.asso_forms_stripe_configure_link()}</button
          >.
        {:else}
          {m.asso_forms_stripe_missing_no_manage()}
        {/if}
      </span>
    </div>
  {/if}

  {#if formsError}
    <div class="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">
      {formsError}
    </div>
  {/if}

  {#if formsLoading}
    <div class="flex justify-center py-8">
      <div
        class="h-6 w-6 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
      ></div>
    </div>
  {:else if forms.length === 0}
    <p class="text-sm text-text-muted text-center py-8">{m.asso_forms_no_forms()}</p>
  {:else}
    <ul class="space-y-4">
      {#each forms as form (form.id)}
        <li class="rounded-xl border border-cn-border/70 bg-cn-bg/40 px-4 py-4 space-y-3">
          <div class="flex items-start justify-between gap-2 flex-wrap">
            <div>
              <p class="font-semibold text-sm text-text-main">{form.title}</p>
              {#if form.description}
                <p class="text-xs text-text-muted mt-0.5 line-clamp-2">{form.description}</p>
              {/if}
              <p class="text-xs text-text-muted mt-1 flex items-center gap-1.5 flex-wrap">
                {form.basePrice > 0
                  ? `${(form.basePrice / 100).toFixed(2)} €`
                  : m.asso_forms_price_free()}
                {form.allowCashPayment ? ` · ${m.asso_forms_cash_accepted()}` : ''}
                {#if form.basePrice > 0 && !stripePaymentsReady}
                  <span
                    class="inline-flex items-center gap-1 text-amber-700 font-medium"
                    title="Stripe Connect not configured - online payments inactive"
                  >
                    <AlertTriangle size={11} />
                    {m.asso_forms_stripe_not_configured_badge()}
                  </span>
                {/if}
              </p>
            </div>
            <a
              href="/forms/{form.id}"
              class="text-xs font-semibold text-cn-yellow hover:underline shrink-0"
              target="_blank"
              rel="noopener noreferrer">{m.asso_forms_view_link()}</a
            >
          </div>

          {#if pendingCash[form.id]?.length}
            <div class="border-t border-cn-border/50 pt-3 space-y-2">
              <p class="text-xs font-bold text-amber-700 flex items-center gap-1.5">
                <AlertTriangle size={13} />
                {m.asso_forms_pending_cash_label({ count: pendingCash[form.id].length })}
              </p>
              <ul class="space-y-2">
                {#each pendingCash[form.id] as sub (sub.id)}
                  <li
                    class="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2"
                  >
                    <div class="min-w-0 flex-1">
                      <p class="text-xs font-semibold text-text-main truncate">
                        {getUserDisplayNameSync(sub.userId)}
                      </p>
                      <p class="text-xs text-text-muted">
                        {(sub.totalPaid / 100).toFixed(2)} € · {new Date(
                          sub.createdAt
                        ).toLocaleDateString(getLocale() === 'en' ? 'en-US' : 'fr-FR')}
                      </p>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onclick={() => validateCash(form.id, sub.id)}
                        class="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 transition-colors"
                        >{m.common_validate_button()}</button
                      >
                      <button
                        type="button"
                        onclick={() => cancelCash(form.id, sub.id)}
                        class="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-100 transition-colors"
                        >{m.common_cancel_button()}</button
                      >
                    </div>
                  </li>
                {/each}
              </ul>
            </div>
          {:else if form.allowCashPayment}
            <p class="text-xs text-text-muted border-t border-cn-border/50 pt-3">
              {m.asso_forms_no_pending_cash()}
            </p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
