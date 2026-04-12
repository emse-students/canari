<script lang="ts">
  import { loadStripe } from '@stripe/stripe-js';
  import type { Stripe, StripeElements } from '@stripe/stripe-js';
  import { onMount, onDestroy } from 'svelte';
  import { X, Loader2, AlertCircle, CreditCard } from 'lucide-svelte';
  import { confirmSubmissionPayment } from '$lib/stores/user';

  interface Props {
    clientSecret: string;
    paymentIntentId: string;
    submissionId: string;
    totalCents: number;
    currency?: string;
    onSuccess: () => void;
    onClose: () => void;
  }

  let {
    clientSecret,
    paymentIntentId,
    submissionId,
    totalCents,
    currency = 'eur',
    onSuccess,
    onClose,
  }: Props = $props();

  let stripe = $state<Stripe | null>(null);
  let elements = $state<StripeElements | null>(null);
  let mountError = $state('');
  let payError = $state('');
  let paying = $state(false);
  let loading = $state(true);

  const formatted = $derived(
    new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(totalCents / 100)
  );

  onMount(async () => {
    const key = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
    if (!key) {
      mountError = 'Clé Stripe non configurée.';
      loading = false;
      return;
    }
    try {
      stripe = await loadStripe(key);
      if (!stripe) {
        mountError = 'Impossible de charger le module de paiement.';
        loading = false;
        return;
      }
      elements = stripe.elements({
        clientSecret,
        appearance: {
          theme: 'flat',
          variables: {
            colorPrimary: '#1a1a1a',
            colorBackground: '#ffffff',
            colorText: '#1a1a1a',
            colorDanger: '#dc2626',
            fontFamily: 'system-ui, sans-serif',
            borderRadius: '12px',
            spacingUnit: '4px',
          },
          rules: {
            '.Input': {
              border: '2px solid #e5e7eb',
              padding: '12px 16px',
              fontSize: '14px',
            },
            '.Input:focus': {
              border: '2px solid #facc15',
              boxShadow: '0 0 0 4px rgba(250,204,21,0.15)',
            },
            '.Label': {
              fontWeight: '700',
              fontSize: '13px',
              marginBottom: '6px',
            },
          },
        },
      });

      const paymentElement = elements.create('payment', {
        layout: 'tabs',
        wallets: { applePay: 'auto', googlePay: 'auto' },
      });

      paymentElement.mount('#stripe-payment-element');
      loading = false;
    } catch (err: unknown) {
      const error = err as Error;
      mountError = error?.message ?? 'Erreur lors du chargement du paiement.';
      loading = false;
    }
  });

  onDestroy(() => {
    elements?.getElement('payment')?.unmount();
  });

  async function handlePay() {
    if (!stripe || !elements) return;
    paying = true;
    payError = '';

    const returnUrl = `${window.location.origin}/forms/success?submission_id=${submissionId}`;

    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
      redirect: 'if_required',
    });

    if (error) {
      payError = error.message ?? 'Le paiement a échoué.';
      paying = false;
      return;
    }

    if (paymentIntent?.status === 'succeeded') {
      // Verify server-side and mark paid
      try {
        await confirmSubmissionPayment(submissionId, paymentIntentId);
      } catch {
        // Webhook will handle it as fallback
      }
      onSuccess();
    } else {
      payError = 'Statut de paiement inattendu. Veuillez réessayer.';
      paying = false;
    }
  }
</script>

<!-- Backdrop -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4"
  role="dialog"
  aria-modal="true"
  aria-label="Paiement"
>
  <div class="w-full max-w-md rounded-2xl border border-cn-border bg-white shadow-2xl">
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
        disabled={paying}
      >
        <X size={18} />
      </button>
    </div>

    <!-- Body -->
    <div class="px-6 py-5 space-y-4">
      {#if mountError}
        <div
          class="flex items-start gap-2 rounded-xl bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm"
        >
          <AlertCircle size={16} class="shrink-0 mt-0.5" />
          {mountError}
        </div>
      {:else}
        {#if loading}
          <div class="flex items-center justify-center py-8 gap-3 text-text-muted">
            <Loader2 size={20} class="animate-spin" />
            <span class="text-sm">Chargement…</span>
          </div>
        {/if}

        <!-- Stripe mounts here -->
        <div id="stripe-payment-element" class:hidden={loading}></div>

        {#if payError}
          <div
            class="flex items-start gap-2 rounded-xl bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm"
          >
            <AlertCircle size={16} class="shrink-0 mt-0.5" />
            {payError}
          </div>
        {/if}

        {#if !loading}
          <button
            onclick={handlePay}
            disabled={paying}
            class="w-full rounded-xl bg-cn-yellow py-3 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {#if paying}
              <Loader2 size={16} class="animate-spin" />
              Paiement en cours…
            {:else}
              Payer {formatted}
            {/if}
          </button>
        {/if}
      {/if}
    </div>

    <!-- Footer -->
    <div class="px-6 pb-5 flex items-center justify-center gap-1.5 text-xs text-text-muted">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        ><rect width="11" height="11" x="3" y="11" rx="2" /><path
          d="M7 11V7a5 5 0 0 1 10 0v4"
        /></svg
      >
      Paiement sécurisé par Stripe
    </div>
  </div>
</div>
