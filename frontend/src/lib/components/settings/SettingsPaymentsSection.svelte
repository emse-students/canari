<script lang="ts">
  import { onMount } from 'svelte';
  import { CreditCard, Plus, Trash2, Loader2, AlertCircle, CheckCircle2 } from '@lucide/svelte';
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
  class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-6 md:p-8 shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200"
  style="animation-fill-mode: backwards;"
>
  <div class="flex items-center justify-between mb-6">
    <div class="flex items-center gap-3">
      <div class="p-2.5 rounded-xl bg-cn-yellow/10 text-cn-dark">
        <CreditCard size={22} strokeWidth={2.5} />
      </div>
      <h2 class="text-lg font-extrabold text-text-main">{m.profile_payment_heading()}</h2>
    </div>

    <button
      onclick={handleSetupPayment}
      disabled={paymentSetupLoading}
      class="hidden sm:inline-flex items-center gap-2 rounded-xl bg-black/5 dark:bg-white/10 px-4 py-2 text-sm font-bold text-text-main hover:bg-black/10 dark:hover:bg-white/20 transition-all disabled:opacity-50 active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-text-muted"
    >
      {#if paymentSetupLoading}
        <Loader2 size={16} class="animate-spin" /> {m.profile_payment_redirecting()}
      {:else}
        <Plus size={18} strokeWidth={2.5} /> {m.profile_payment_add_card()}
      {/if}
    </button>
  </div>

  {#if paymentSuccess}
    <div
      transition:slide={{ duration: 200 }}
      class="flex items-center gap-3 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 dark:text-emerald-400 p-4 text-sm font-bold mb-6 shadow-inner"
    >
      <CheckCircle2 size={20} class="shrink-0" />
      {paymentSuccess}
    </div>
  {/if}

  {#if paymentError}
    <div
      transition:slide={{ duration: 200 }}
      class="flex items-center gap-3 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 p-4 text-sm font-bold mb-6 shadow-inner"
    >
      <AlertCircle size={20} class="shrink-0" />
      {paymentError}
    </div>
  {/if}

  {#if paymentLoading}
    <div class="flex items-center gap-3 text-sm font-semibold text-text-muted py-4">
      <Loader2 size={18} class="animate-spin" />
      {m.profile_payment_loading()}
    </div>
  {:else}
    {#if paymentMethods.length > 0}
      <div class="space-y-3 mb-6">
        {#each paymentMethods as pm (pm.id)}
          <div
            transition:slide={{ duration: 200 }}
            class="flex items-center justify-between rounded-[1.25rem] bg-gradient-to-r from-black/5 to-transparent dark:from-white/5 dark:to-transparent border border-black/5 dark:border-white/5 px-5 py-4 group hover:border-black/10 dark:hover:border-white/10 transition-colors shadow-sm"
          >
            <div class="flex items-center gap-4">
              <div
                class="w-8 h-6 rounded bg-cn-yellow/20 border border-cn-yellow/30 flex items-center justify-center opacity-80"
              >
                <div class="w-4 h-3 border border-cn-yellow/40 rounded-sm"></div>
              </div>

              <div class="flex flex-col">
                <span class="text-[0.95rem] font-bold text-text-main tracking-wider font-mono">
                  •••• •••• •••• {pm.last4}
                </span>
                <span
                  class="text-[0.65rem] font-extrabold text-text-muted uppercase tracking-wider mt-0.5"
                >
                  {brandLabel(pm.brand)} • Exp: {String(pm.expMonth).padStart(2, '0')}/{pm.expYear}
                </span>
              </div>
            </div>

            <button
              onclick={() => handleDeletePaymentMethod(pm.id)}
              class="p-2.5 rounded-xl text-text-muted hover:text-red-500 hover:bg-red-500/10 transition-all opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 outline-none focus-visible:ring-2 focus-visible:ring-red-500 active:scale-95"
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
        class="text-center py-6 px-4 border border-dashed border-black/10 dark:border-white/10 rounded-[1.25rem] bg-black/5 dark:bg-white/5 mb-6"
      >
        <p class="text-sm font-semibold text-text-muted">{m.profile_payment_none_title()}</p>
      </div>
    {/if}

    <button
      onclick={handleSetupPayment}
      disabled={paymentSetupLoading}
      class="sm:hidden w-full flex items-center justify-center gap-2 rounded-xl bg-black/5 dark:bg-white/10 px-4 py-3.5 text-sm font-bold text-text-main active:scale-[0.98] transition-all disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-text-muted"
    >
      {#if paymentSetupLoading}
        <Loader2 size={18} class="animate-spin" /> {m.profile_payment_redirect_stripe()}
      {:else}
        <Plus size={18} strokeWidth={2.5} /> {m.profile_payment_add_card_mobile()}
      {/if}
    </button>
  {/if}
</div>
