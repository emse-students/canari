<script lang="ts">
  import { CreditCard, X, Loader2, CheckCircle2, AlertCircle, ChevronRight } from '@lucide/svelte';
  import type { PaymentMethod } from '$lib/stores/user';
  import { focusTrap } from '$lib/actions/focusTrap.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** List of saved payment methods to display. */
    paymentMethods: PaymentMethod[];
    /** Amount to charge, expressed in the smallest currency unit (e.g. cents). */
    totalCents: number;
    /** ISO 4217 currency code (lowercase). */
    currency?: string;
    /** Called when user picks a saved method. Returns true on success. */
    onPayWithSaved: (
      paymentMethodId: string
    ) => Promise<{ ok: boolean; requiresAction?: boolean; clientSecret?: string; error?: string }>;
    /** Called when user wants to pay with a new card (Stripe hosted checkout). */
    onPayWithNew: () => void;
    /** Called when inline 3DS authentication succeeds. No longer triggered directly
     * by this modal (3DS redirects to Stripe Checkout via onPayWithNew instead).
     * Kept in the interface for API compatibility; callers may pass it safely.
     */
    onSuccess?: () => void;
    /** Called when payment fails definitively (not when 3DS is required). */
    onPaymentFailed?: () => void | Promise<void>;
    /** Called when the modal is dismissed. */
    onClose: () => void;
  }

  let {
    paymentMethods,
    totalCents,
    currency = 'eur',
    onPayWithSaved,
    onPayWithNew,
    onSuccess: _onSuccess,
    onPaymentFailed,
    onClose,
  }: Props = $props();

  let selectedMethodId = $state('');
  let paying = $state(false);
  let error = $state('');

  $effect(() => {
    if (!selectedMethodId && paymentMethods.length > 0) {
      selectedMethodId = paymentMethods[0].id;
    }
  });

  const formatted = $derived(
    new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(totalCents / 100)
  );

  function brandLabel(brand: string): string {
    const labels: Record<string, string> = {
      visa: 'Visa',
      mastercard: 'Mastercard',
      amex: 'American Express',
    };
    return labels[brand] ?? brand.charAt(0).toUpperCase() + brand.slice(1);
  }

  async function notifyPaymentFailed() {
    try {
      await onPaymentFailed?.();
    } catch {
      // Caller handles logging; keep modal error visible.
    }
  }

  async function handlePay() {
    if (!selectedMethodId) return;
    paying = true;
    error = '';
    try {
      const result = await onPayWithSaved(selectedMethodId);
      if (!result.ok) {
        if (result.requiresAction && result.clientSecret) {
          // 3DS inline loads Stripe.js/hCaptcha and triggers strict CSP console errors - use Checkout.
          onPayWithNew();
          paying = false;
          return;
        } else {
          error = result.error ?? m.payment_modal_error_default();
          paying = false;
          await notifyPaymentFailed();
        }
      }
      // If ok, caller handles redirect
    } catch {
      error = m.payment_modal_error_generic();
      paying = false;
      await notifyPaymentFailed();
    }
  }
</script>

<!-- Backdrop -->
<div
  data-keyboard-aware-overlay
  class="z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center"
  role="presentation"
>
  <div
    use:focusTrap
    role="dialog"
    aria-modal="true"
    aria-label={m.payment_modal_title()}
    class="keyboard-aware-modal-panel border-cn-border bg-cn-surface max-h-[min(92dvh,var(--app-viewport-height,100dvh))] w-full max-w-md overflow-y-auto rounded-t-3xl border shadow-2xl sm:rounded-2xl"
  >
    <!-- Header -->
    <div class="border-cn-border flex items-center justify-between border-b px-6 pt-5 pb-4">
      <div class="flex items-center gap-2.5">
        <div class="bg-cn-yellow/15 text-cn-dark rounded-xl p-2">
          <CreditCard size={20} />
        </div>
        <div>
          <h2 class="text-text-main text-base font-extrabold">{m.payment_modal_title()}</h2>
          <p class="text-text-muted text-xs">
            {m.payment_modal_amount_label({ amount: formatted })}
          </p>
        </div>
      </div>
      <button
        onclick={onClose}
        class="text-text-muted hover:text-text-main hover:bg-cn-border/30 rounded-lg p-1.5 transition-colors"
        aria-label="Fermer"
      >
        <X size={18} />
      </button>
    </div>

    <!-- Body -->
    <div class="space-y-3 px-6 py-5">
      {#if error}
        <div
          class="bg-red-err/10 border-red-err/30 text-red-err flex items-start gap-2 rounded-xl border px-4 py-3 text-sm"
        >
          <AlertCircle size={16} class="mt-0.5 shrink-0" />
          {error}
        </div>
      {/if}

      <p class="text-text-main text-sm font-semibold">{m.payment_modal_saved_card()}</p>

      <div class="space-y-2">
        {#each paymentMethods as pm (pm.id)}
          <label
            class="flex cursor-pointer items-center gap-3 rounded-xl border-2 px-4 py-3 transition-colors
            {selectedMethodId === pm.id
              ? 'border-cn-yellow bg-cn-yellow/5'
              : 'border-cn-border hover:border-cn-yellow/50'}"
          >
            <input
              type="radio"
              name="pm"
              value={pm.id}
              bind:group={selectedMethodId}
              class="sr-only"
            />
            <div class="flex min-w-0 flex-1 items-center gap-3">
              <CreditCard size={18} class="text-text-muted shrink-0" />
              <div class="min-w-0">
                <p class="text-text-main text-sm font-bold">
                  {brandLabel(pm.brand)} •••• {pm.last4}
                </p>
                <p class="text-text-muted text-xs">
                  {m.payment_modal_expires({ month: pm.expMonth, year: pm.expYear })}
                </p>
              </div>
            </div>
            {#if selectedMethodId === pm.id}
              <CheckCircle2 size={18} class="text-cn-dark shrink-0" />
            {/if}
          </label>
        {/each}
      </div>

      <button
        onclick={handlePay}
        disabled={!selectedMethodId || paying}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold transition-colors disabled:opacity-50"
      >
        {#if paying}
          <Loader2 size={16} class="animate-spin" />
          {m.payment_modal_paying()}
        {:else}
          {formatted}
          <ChevronRight size={16} />
        {/if}
      </button>
    </div>

    <!-- Footer -->
    <div class="px-6 pb-5">
      <div class="relative mb-3 flex items-center gap-3">
        <div class="border-cn-border flex-1 border-t"></div>
        <span class="text-text-muted text-xs">{m.payment_modal_or()}</span>
        <div class="border-cn-border flex-1 border-t"></div>
      </div>
      <button
        onclick={onPayWithNew}
        class="border-cn-border text-text-muted hover:text-text-main hover:border-cn-yellow/50 w-full rounded-xl border py-2.5 text-sm font-semibold transition-colors"
      >
        {m.payment_modal_pay_new_card()}
      </button>
    </div>
  </div>
</div>
