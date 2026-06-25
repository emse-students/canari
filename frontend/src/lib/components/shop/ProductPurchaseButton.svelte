<script lang="ts">
  import { onMount } from 'svelte';
  import { createProductCheckout, type AssociationProduct } from '$lib/associations/api';
  import {
    listPaymentMethods,
    chargeProductWithSavedMethod,
    type PaymentMethod,
  } from '$lib/stores/user';
  import { shopCheckoutCallbacks } from '$lib/utils/stripeCallbacks';
  import { showToast } from '$lib/stores/toast.svelte';
  import PaymentModal from '$lib/components/ui/PaymentModal.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    product: AssociationProduct;
    /** Custom amount in euros when the product allows a free-form price. */
    customAmountEuros?: number;
    /** Override the default action label (Cotiser / Recharger / Acheter). */
    label?: string;
    variant?: 'accent' | 'yellow';
    class?: string;
    disabled?: boolean;
  }

  let {
    product,
    customAmountEuros,
    label,
    variant = 'accent',
    class: className = '',
    disabled = false,
  }: Props = $props();

  let checkingOut = $state(false);
  let paymentMethods = $state<PaymentMethod[]>([]);
  let showPaymentModal = $state(false);
  let pendingCheckoutUrl = $state('');
  let pendingAmountCents = $state(0);
  let pendingCurrency = $state('eur');

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

  onMount(async () => {
    try {
      paymentMethods = await listPaymentMethods();
    } catch {
      // Stripe may not be configured
    }
  });

  /** Resolves custom amount in cents when applicable. */
  function resolveCustomCents(): number | undefined {
    if (product.allowCustomAmount && product.amountCents === null) {
      if (customAmountEuros == null || customAmountEuros <= 0) return undefined;
      return Math.round(customAmountEuros * 100);
    }
    return undefined;
  }

  async function handlePurchase() {
    checkingOut = true;
    try {
      const customCents = resolveCustomCents();
      if (product.allowCustomAmount && product.amountCents === null && customCents === undefined) {
        showToast(m.shop_indicate_amount());
        return;
      }
      const res = await createProductCheckout(
        product.associationId,
        product.id,
        customCents,
        shopCheckoutCallbacks(product.id)
      );
      if (paymentMethods.length > 0 && res.amountCents > 0) {
        pendingCheckoutUrl = res.checkoutUrl;
        pendingAmountCents = res.amountCents;
        pendingCurrency = res.currency ?? product.currency;
        showPaymentModal = true;
      } else {
        const { navigateExternal } = await import('$lib/utils/openExternal');
        await navigateExternal(res.checkoutUrl);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : m.shop_payment_error());
    } finally {
      checkingOut = false;
    }
  }

  async function handlePayWithSaved(paymentMethodId: string) {
    const result = await chargeProductWithSavedMethod(
      product.associationId,
      product.id,
      paymentMethodId,
      resolveCustomCents()
    );
    if (result.ok) {
      showPaymentModal = false;
      showToast(m.shop_purchase_success());
    }
    return result;
  }

  async function handlePayWithNew() {
    showPaymentModal = false;
    const { navigateExternal } = await import('$lib/utils/openExternal');
    await navigateExternal(pendingCheckoutUrl);
  }
</script>

<button
  type="button"
  onclick={() => void handlePurchase()}
  disabled={isDisabled}
  class="{variant === 'yellow'
    ? 'bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover'
    : 'bg-cn-accent text-white hover:opacity-90'} inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-bold transition-opacity disabled:opacity-50 disabled:cursor-not-allowed {className}"
>
  {#if checkingOut}
    <span
      class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    ></span>
  {:else}
    {buttonLabel}
  {/if}
</button>

{#if showPaymentModal}
  <PaymentModal
    {paymentMethods}
    totalCents={pendingAmountCents}
    currency={pendingCurrency}
    onPayWithSaved={handlePayWithSaved}
    onPayWithNew={handlePayWithNew}
    onClose={() => (showPaymentModal = false)}
  />
{/if}
