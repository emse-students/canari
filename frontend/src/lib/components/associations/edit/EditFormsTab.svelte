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

<div class="border-cn-border space-y-5 rounded-2xl border bg-(--cn-surface)/95 p-6 shadow-sm">
  <div>
    <h2 class="text-text-main flex items-center gap-2 text-lg font-bold tracking-tight">
      <ClipboardList size={20} />
      {m.asso_forms_title()}
    </h2>
    <p class="text-text-muted mt-1 text-sm">
      {m.asso_forms_subtitle()}
    </p>
  </div>

  {#if hasPaidForms && !stripePaymentsReady}
    <div
      class="border-amber-warn/30 bg-amber-warn/10 text-amber-warn flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm"
    >
      <AlertTriangle size={15} class="mt-0.5 shrink-0" />
      <span>
        {#if canManageStripeConnect}
          {m.asso_forms_stripe_missing_can_manage_prefix()}<strong
            >{m.asso_forms_stripe_missing_strong()}</strong
          >{m.asso_forms_stripe_missing_suffix()}<button
            type="button"
            class="font-semibold underline hover:no-underline"
            onclick={onGoToPayments}>{m.asso_forms_stripe_configure_link()}</button
          >.
        {:else}
          {m.asso_forms_stripe_missing_no_manage()}
        {/if}
      </span>
    </div>
  {/if}

  {#if formsError}
    <div class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-4 py-3 text-sm">
      {formsError}
    </div>
  {/if}

  {#if formsLoading}
    <div class="flex justify-center py-8">
      <div
        class="border-cn-yellow h-6 w-6 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else if forms.length === 0}
    <p class="text-text-muted py-8 text-center text-sm">{m.asso_forms_no_forms()}</p>
  {:else}
    <ul class="space-y-4">
      {#each forms as form (form.id)}
        <li class="border-cn-border/70 bg-cn-bg/40 space-y-3 rounded-xl border px-4 py-4">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p class="text-text-main text-sm font-semibold">{form.title}</p>
              {#if form.description}
                <p class="text-text-muted mt-0.5 line-clamp-2 text-xs">{form.description}</p>
              {/if}
              <p class="text-text-muted mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                {form.basePrice > 0
                  ? `${(form.basePrice / 100).toFixed(2)} €`
                  : m.asso_forms_price_free()}
                {form.allowCashPayment ? ` · ${m.asso_forms_cash_accepted()}` : ''}
                {#if form.basePrice > 0 && !stripePaymentsReady}
                  <span
                    class="text-amber-warn inline-flex items-center gap-1 font-medium"
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
              class="text-cn-yellow shrink-0 text-xs font-semibold hover:underline"
              target="_blank"
              rel="noopener noreferrer">{m.asso_forms_view_link()}</a
            >
          </div>

          {#if pendingCash[form.id]?.length}
            <div class="border-cn-border/50 space-y-2 border-t pt-3">
              <p class="text-amber-warn flex items-center gap-1.5 text-xs font-bold">
                <AlertTriangle size={13} />
                {m.asso_forms_pending_cash_label({ count: pendingCash[form.id].length })}
              </p>
              <ul class="space-y-2">
                {#each pendingCash[form.id] as sub (sub.id)}
                  <li
                    class="border-amber-warn/30 bg-amber-warn/10 flex items-center gap-3 rounded-xl border px-3 py-2"
                  >
                    <div class="min-w-0 flex-1">
                      <p class="text-text-main truncate text-xs font-semibold">
                        {getUserDisplayNameSync(sub.userId)}
                      </p>
                      <p class="text-text-muted text-xs">
                        {(sub.totalPaid / 100).toFixed(2)} € · {new Date(
                          sub.createdAt
                        ).toLocaleDateString(getLocale() === 'en' ? 'en-US' : 'fr-FR')}
                      </p>
                    </div>
                    <div class="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onclick={() => validateCash(form.id, sub.id)}
                        class="border-green-ok/40 bg-green-ok/10 text-green-ok hover:bg-green-ok/20 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors"
                        >{m.common_validate_button()}</button
                      >
                      <button
                        type="button"
                        onclick={() => cancelCash(form.id, sub.id)}
                        class="border-red-err/30 bg-red-err/10 text-red-err hover:bg-red-err/20 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors"
                        >{m.common_cancel_button()}</button
                      >
                    </div>
                  </li>
                {/each}
              </ul>
            </div>
          {:else if form.allowCashPayment}
            <p class="text-text-muted border-cn-border/50 border-t pt-3 text-xs">
              {m.asso_forms_no_pending_cash()}
            </p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
