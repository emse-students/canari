<script lang="ts">
  import { CreditCard, X, Loader2, CheckCircle2, AlertCircle, ChevronRight } from '@lucide/svelte';
  import type { PaymentMethod } from '$lib/stores/user';
  import { focusTrap } from '$lib/actions/focusTrap.svelte';

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
    /** Called when inline 3DS authentication succeeds. */
    onSuccess: () => void;
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
    onSuccess,
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
          // 3DS inline loads Stripe.js/hCaptcha and triggers strict CSP console errors — use Checkout.
          onPayWithNew();
          paying = false;
          return;
        } else {
          error = result.error ?? 'Le paiement a échoué. Veuillez réessayer.';
          paying = false;
          await notifyPaymentFailed();
        }
      }
      // If ok, caller handles redirect
    } catch {
      error = 'Une erreur est survenue lors du paiement.';
      paying = false;
      await notifyPaymentFailed();
    }
  }
</script>

<!-- Backdrop -->
<div
  data-keyboard-aware-overlay
  class="z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm"
  role="presentation"
>
  <div
    use:focusTrap
    role="dialog"
    aria-modal="true"
    aria-label="Paiement"
    class="keyboard-aware-modal-panel w-full max-w-md rounded-t-3xl sm:rounded-2xl border border-cn-border bg-white shadow-2xl max-h-[min(92dvh,var(--app-viewport-height,100dvh))] overflow-y-auto"
  >
    <!-- Header -->
    <div class="flex items-center justify-between px-6 pt-5 pb-4 border-b border-cn-border">
      <div class="flex items-center gap-2.5">
        <div class="p-2 rounded-xl bg-cn-yellow/15 text-cn-dark">
          <CreditCard size={20} />
        </div>
        <div>
          <h2 class="text-base font-extrabold text-text-main">Paiement</h2>
          <p class="text-xs text-text-muted">Montant : {formatted}</p>
        </div>
      </div>
      <button
        onclick={onClose}
        class="p-1.5 rounded-lg text-text-muted hover:text-text-main hover:bg-cn-border/30 transition-colors"
        aria-label="Fermer"
      >
        <X size={18} />
      </button>
    </div>

    <!-- Body -->
    <div class="px-6 py-5 space-y-3">
      {#if error}
        <div
          class="flex items-start gap-2 rounded-xl bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm"
        >
          <AlertCircle size={16} class="shrink-0 mt-0.5" />
          {error}
        </div>
      {/if}

      <p class="text-sm font-semibold text-text-main">Carte enregistrée</p>

      <div class="space-y-2">
        {#each paymentMethods as pm (pm.id)}
          <label
            class="flex items-center gap-3 rounded-xl border-2 px-4 py-3 cursor-pointer transition-colors
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
            <div class="flex-1 flex items-center gap-3 min-w-0">
              <CreditCard size={18} class="text-text-muted shrink-0" />
              <div class="min-w-0">
                <p class="text-sm font-bold text-text-main">
                  {brandLabel(pm.brand)} •••• {pm.last4}
                </p>
                <p class="text-xs text-text-muted">Expire {pm.expMonth}/{pm.expYear}</p>
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
        class="w-full rounded-xl bg-cn-yellow py-3 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {#if paying}
          <Loader2 size={16} class="animate-spin" />
          Paiement en cours…
        {:else}
          Payer {formatted}
          <ChevronRight size={16} />
        {/if}
      </button>
    </div>

    <!-- Footer -->
    <div class="px-6 pb-5">
      <div class="relative flex items-center gap-3 mb-3">
        <div class="flex-1 border-t border-cn-border"></div>
        <span class="text-xs text-text-muted">ou</span>
        <div class="flex-1 border-t border-cn-border"></div>
      </div>
      <button
        onclick={onPayWithNew}
        class="w-full rounded-xl border border-cn-border py-2.5 text-sm font-semibold text-text-muted hover:text-text-main hover:border-cn-yellow/50 transition-colors"
      >
        Payer avec une autre carte
      </button>
    </div>
  </div>
</div>
