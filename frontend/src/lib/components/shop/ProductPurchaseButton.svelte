<script lang="ts">
  import { onMount } from 'svelte';
  import { createProductCheckout, type AssociationProduct } from '$lib/associations/api';
  import { providerRefusalMessage } from '$lib/associations/paymentRefusal';
  import { shopCheckoutCallbacks } from '$lib/utils/checkoutCallbacks';
  import { showToast } from '$lib/stores/toast.svelte';
  import PayerEmailPrompt from '$lib/components/payments/PayerEmailPrompt.svelte';
  import {
    activePaymentProvider,
    loadActivePaymentProvider,
  } from '$lib/associations/activePaymentProvider.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    product: AssociationProduct;
    /** Custom amount in euros when the product allows a free-form price. */
    customAmountEuros?: number;
    /** Override the default action label (Cotiser / Recharger / Acheter). */
    label?: string;
    class?: string;
    disabled?: boolean;
  }

  let {
    product,
    customAmountEuros,
    label,
    class: className = '',
    disabled = false,
  }: Props = $props();

  let checkingOut = $state(false);
  let askingPayerEmail = $state(false);

  const buttonLabel = $derived(
    label ??
      (product.type === 'membership'
        ? m.shop_product_type_membership()
        : product.type === 'balance_topup'
          ? m.shop_product_type_topup()
          : m.shop_product_type_buy())
  );

  const isDisabled = $derived(
    disabled ||
      checkingOut ||
      (product.allowCustomAmount &&
        product.amountCents === null &&
        (customAmountEuros == null || customAmountEuros <= 0))
  );

  onMount(() => {
    void loadActivePaymentProvider();
  });

  /** Resolves custom amount in cents when applicable. */
  function resolveCustomCents(): number | undefined {
    if (product.allowCustomAmount && product.amountCents === null) {
      if (customAmountEuros == null || customAmountEuros <= 0) return undefined;
      return Math.round(customAmountEuros * 100);
    }
    return undefined;
  }

  /** Lydia's request/do needs the payer's address and Canari stores none, so the payer types it. */
  function handlePurchase() {
    const customCents = resolveCustomCents();
    if (product.allowCustomAmount && product.amountCents === null && customCents === undefined) {
      showToast(m.shop_indicate_amount());
      return;
    }
    if (activePaymentProvider.current === 'lydia') {
      askingPayerEmail = true;
      return;
    }
    void runCheckout();
  }

  async function runCheckout(payerEmail?: string) {
    checkingOut = true;
    try {
      const res = await createProductCheckout(
        product.associationId,
        product.id,
        resolveCustomCents(),
        shopCheckoutCallbacks(product.id),
        payerEmail
      );
      const { navigateExternal } = await import('$lib/utils/openExternal');
      await navigateExternal(res.checkoutUrl);
    } catch (err) {
      // A provider refusal (Lydia: blocked venue, bad phone...) is an answer about THIS purchase and
      // carries a readable reason; every other failure keeps the generic line.
      showToast(providerRefusalMessage(err) ?? m.shop_payment_error());
    } finally {
      checkingOut = false;
    }
  }
</script>

<button
  type="button"
  onclick={handlePurchase}
  disabled={isDisabled}
  class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-bold transition-opacity disabled:cursor-not-allowed disabled:opacity-50 {className}"
>
  {#if checkingOut}
    <span
      class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    ></span>
  {:else}
    {buttonLabel}
  {/if}
</button>

{#if askingPayerEmail}
  <PayerEmailPrompt
    onSubmit={(email) => {
      askingPayerEmail = false;
      void runCheckout(email);
    }}
    onClose={() => (askingPayerEmail = false)}
  />
{/if}
