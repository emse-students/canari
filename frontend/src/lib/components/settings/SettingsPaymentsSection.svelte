<script lang="ts">
  import { onMount } from 'svelte';
  import { CreditCard, Plus, Trash2, LoaderCircle, CircleAlert, CircleCheck } from '@lucide/svelte';
  import { slide } from 'svelte/transition';
  import {
    setupPaymentMethod,
    listPaymentMethods,
    deletePaymentMethod,
    type PaymentMethod,
  } from '$lib/stores/user';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { m } from '$lib/paraglide/messages';

  // Saved Stripe cards. State is owned here; the section also resolves the Stripe Setup
  // redirect (?payment_setup=success) since the return URL lands on this page.
  let paymentMethods = $state<PaymentMethod[]>([]);
  let paymentLoading = $state(false);
  let paymentSetupLoading = $state(false);
  let paymentError = $state('');
  let paymentSuccess = $state('');

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('payment_setup') === 'success') {
      paymentSuccess = m.profile_payment_setup_success();
      history.replaceState(null, '', '/settings');
    }
    void loadPaymentMethods();
  });

  // Auto-clear the success banner.
  $effect(() => {
    if (paymentSuccess) {
      const timer = setTimeout(() => (paymentSuccess = ''), 4000);
      return () => clearTimeout(timer);
    }
  });

  async function loadPaymentMethods() {
    paymentLoading = true;
    try {
      paymentMethods = await listPaymentMethods();
    } catch {
      // Ignore - Stripe may not be configured
    } finally {
      paymentLoading = false;
    }
  }

  async function handleSetupPayment() {
    paymentSetupLoading = true;
    paymentError = '';
    try {
      const { settingsSetupCallbacks } = await import('$lib/utils/stripeCallbacks');
      const result = await setupPaymentMethod(settingsSetupCallbacks());
      if (result.url) {
        const { navigateExternal } = await import('$lib/utils/openExternal');
        await navigateExternal(result.url);
      }
    } catch (err) {
      paymentError = err instanceof Error ? err.message : m.profile_payment_setup_error();
      paymentSetupLoading = false;
    }
  }

  async function handleDeletePaymentMethod(id: string) {
    if (
      !(await showConfirm(m.profile_payment_delete_confirm(), {
        danger: true,
        confirmLabel: m.common_delete_button(),
      }))
    )
      return;
    try {
      await deletePaymentMethod(id);
      paymentMethods = paymentMethods.filter((pm) => pm.id !== id);
    } catch (err) {
      paymentError = err instanceof Error ? err.message : m.profile_payment_delete_error_fallback();
    }
  }

  function brandLabel(brand: string): string {
    const labels: Record<string, string> = {
      visa: 'Visa',
      mastercard: 'Mastercard',
      amex: 'American Express',
    };
    return labels[brand] ?? brand.charAt(0).toUpperCase() + brand.slice(1);
  }
</script>

<div
  class="border-cn-border animate-in fade-in slide-in-from-bottom-4 rounded-2xl border bg-[var(--cn-surface)] p-6 shadow-sm delay-200 duration-500 md:p-8"
  style="animation-fill-mode: backwards;"
>
  <div class="mb-6 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="bg-cn-yellow/10 text-cn-dark rounded-xl p-2.5">
        <CreditCard size={22} strokeWidth={2.5} />
      </div>
      <h2 class="text-text-main text-lg font-extrabold">{m.profile_payment_heading()}</h2>
    </div>

    <button
      onclick={handleSetupPayment}
      disabled={paymentSetupLoading}
      class="text-text-main focus-visible:ring-text-muted hidden items-center gap-2 rounded-xl bg-black/5 px-4 py-2 text-sm font-bold transition-all outline-none hover:bg-black/10 focus-visible:ring-2 active:scale-95 disabled:opacity-50 sm:inline-flex dark:bg-white/10 dark:hover:bg-white/20"
    >
      {#if paymentSetupLoading}
        <LoaderCircle size={16} class="animate-spin" /> {m.profile_payment_redirecting()}
      {:else}
        <Plus size={18} strokeWidth={2.5} /> {m.profile_payment_add_card()}
      {/if}
    </button>
  </div>

  {#if paymentSuccess}
    <div
      transition:slide={{ duration: 200 }}
      class="mb-6 flex items-center gap-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm font-bold text-emerald-700 shadow-inner dark:text-emerald-400"
    >
      <CircleCheck size={20} class="shrink-0" />
      {paymentSuccess}
    </div>
  {/if}

  {#if paymentError}
    <div
      transition:slide={{ duration: 200 }}
      class="mb-6 flex items-center gap-3 rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm font-bold text-red-600 shadow-inner dark:text-red-400"
    >
      <CircleAlert size={20} class="shrink-0" />
      {paymentError}
    </div>
  {/if}

  {#if paymentLoading}
    <div class="text-text-muted flex items-center gap-3 py-4 text-sm font-semibold">
      <LoaderCircle size={18} class="animate-spin" />
      {m.profile_payment_loading()}
    </div>
  {:else}
    {#if paymentMethods.length > 0}
      <div class="mb-6 space-y-3">
        {#each paymentMethods as pm (pm.id)}
          <div
            transition:slide={{ duration: 200 }}
            class="group flex items-center justify-between rounded-[1.25rem] border border-black/5 bg-gradient-to-r from-black/5 to-transparent px-5 py-4 shadow-sm transition-colors hover:border-black/10 dark:border-white/5 dark:from-white/5 dark:to-transparent dark:hover:border-white/10"
          >
            <div class="flex items-center gap-4">
              <div
                class="bg-cn-yellow/20 border-cn-yellow/30 flex h-6 w-8 items-center justify-center rounded border opacity-80"
              >
                <div class="border-cn-yellow/40 h-3 w-4 rounded-sm border"></div>
              </div>

              <div class="flex flex-col">
                <span class="text-text-main font-mono text-[0.95rem] font-bold tracking-wider">
                  •••• •••• •••• {pm.last4}
                </span>
                <span
                  class="text-text-muted mt-0.5 text-[0.65rem] font-extrabold tracking-wider uppercase"
                >
                  {brandLabel(pm.brand)} • Exp: {String(pm.expMonth).padStart(2, '0')}/{pm.expYear}
                </span>
              </div>
            </div>

            <button
              onclick={() => handleDeletePaymentMethod(pm.id)}
              class="text-text-muted rounded-xl p-2.5 opacity-100 transition-all outline-none hover:bg-red-500/10 hover:text-red-500 focus:opacity-100 focus-visible:ring-2 focus-visible:ring-red-500 active:scale-95 sm:opacity-0 sm:group-hover:opacity-100"
              title={m.profile_payment_delete_label()}
              aria-label={m.common_delete_button()}
            >
              <Trash2 size={18} strokeWidth={2.5} />
            </button>
          </div>
        {/each}
      </div>
    {:else}
      <div
        class="mb-6 rounded-[1.25rem] border border-dashed border-black/10 bg-black/5 px-4 py-6 text-center dark:border-white/10 dark:bg-white/5"
      >
        <p class="text-text-muted text-sm font-semibold">{m.profile_payment_none_title()}</p>
      </div>
    {/if}

    <button
      onclick={handleSetupPayment}
      disabled={paymentSetupLoading}
      class="text-text-main focus-visible:ring-text-muted flex w-full items-center justify-center gap-2 rounded-xl bg-black/5 px-4 py-3.5 text-sm font-bold transition-all outline-none focus-visible:ring-2 active:scale-[0.98] disabled:opacity-50 sm:hidden dark:bg-white/10"
    >
      {#if paymentSetupLoading}
        <LoaderCircle size={18} class="animate-spin" /> {m.profile_payment_redirect_provider()}
      {:else}
        <Plus size={18} strokeWidth={2.5} /> {m.profile_payment_add_card_mobile()}
      {/if}
    </button>
  {/if}
</div>
