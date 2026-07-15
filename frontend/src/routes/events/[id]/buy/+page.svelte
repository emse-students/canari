<script lang="ts">
  import { getToken } from '$lib/stores/auth';
  import { m } from '$lib/paraglide/messages';

  let { data }: { data: any } = $props();
  let eventId = $derived(data?.eventId || 'unknown-event');

  let options = $state({
    isMemberBDE: false,
    wantsMeal: false,
  });

  let isProcessing = $state(false);
  let paymentError = $state('');

  async function handlePayment() {
    isProcessing = true;
    paymentError = '';

    try {
      let token = '';
      try {
        token = await getToken();
      } catch {
        /* empty */
      }

      const response = await fetch('/api/payments/create-checkout-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ eventId, options }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || m.event_buy_payment_error_fallback());
      }

      if (result.url) {
        const { navigateExternal } = await import('$lib/utils/openExternal');
        await navigateExternal(result.url);
      }
    } catch (error: any) {
      paymentError = error.message;
    } finally {
      isProcessing = false;
    }
  }
</script>

<div class="px-4 py-8 sm:px-6 min-h-dvh flex items-start justify-center">
  <div class="w-full max-w-md rounded-2xl border border-cn-border bg-white/80 p-6 shadow-sm">
    <h1 class="text-2xl font-extrabold text-text-main tracking-tight mb-6">
      {m.event_buy_heading()}
    </h1>

    <div class="space-y-3 mb-6">
      <label
        class="flex items-center gap-3 cursor-pointer select-none p-3 rounded-xl border border-cn-border hover:bg-cn-surface/50 transition-colors"
      >
        <input
          type="checkbox"
          bind:checked={options.isMemberBDE}
          class="w-4 h-4 accent-yellow-400"
        />
        <span class="text-sm font-medium text-text-main">{m.event_buy_option_bde()}</span>
      </label>

      <label
        class="flex items-center gap-3 cursor-pointer select-none p-3 rounded-xl border border-cn-border hover:bg-cn-surface/50 transition-colors"
      >
        <input type="checkbox" bind:checked={options.wantsMeal} class="w-4 h-4 accent-yellow-400" />
        <span class="text-sm font-medium text-text-main">{m.event_buy_option_meal()}</span>
      </label>
    </div>

    {#if paymentError}
      <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-3 mb-4 text-sm">
        {paymentError}
      </div>
    {/if}

    <button
      onclick={handlePayment}
      disabled={isProcessing}
      class="w-full rounded-xl bg-cn-yellow px-4 py-3 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover transition-colors disabled:opacity-50"
    >
      {isProcessing ? m.event_buy_processing() : m.event_buy_pay_btn()}
    </button>
  </div>
</div>
