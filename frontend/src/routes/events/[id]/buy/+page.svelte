<script lang="ts">
  import { getToken } from '$lib/stores/auth';
  import { m } from '$lib/paraglide/messages';
  import { coreUrl } from '$lib/utils/apiUrl';

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

      const response = await fetch(`${coreUrl()}/api/payments/create-checkout-session`, {
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

<div class="flex min-h-dvh items-start justify-center px-4 py-8 sm:px-6">
  <div class="border-cn-border bg-cn-surface/80 w-full max-w-md rounded-2xl border p-6 shadow-sm">
    <h1 class="text-text-main mb-6 text-2xl font-extrabold tracking-tight">
      {m.event_buy_heading()}
    </h1>

    <div class="mb-6 space-y-3">
      <label
        class="border-cn-border hover:bg-cn-surface/50 flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors select-none"
      >
        <input
          type="checkbox"
          bind:checked={options.isMemberBDE}
          class="h-4 w-4 accent-yellow-400"
        />
        <span class="text-text-main text-sm font-medium">{m.event_buy_option_bde()}</span>
      </label>

      <label
        class="border-cn-border hover:bg-cn-surface/50 flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors select-none"
      >
        <input type="checkbox" bind:checked={options.wantsMeal} class="h-4 w-4 accent-yellow-400" />
        <span class="text-text-main text-sm font-medium">{m.event_buy_option_meal()}</span>
      </label>
    </div>

    {#if paymentError}
      <div class="bg-red-err/10 border-red-err/30 text-red-err mb-4 rounded-xl border p-3 text-sm">
        {paymentError}
      </div>
    {/if}

    <button
      onclick={handlePayment}
      disabled={isProcessing}
      class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover w-full rounded-xl px-4 py-3 text-sm font-bold transition-colors disabled:opacity-50"
    >
      {isProcessing ? m.event_buy_processing() : m.event_buy_pay_btn()}
    </button>
  </div>
</div>
