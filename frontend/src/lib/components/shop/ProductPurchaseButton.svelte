<script lang="ts">
  import { onMount } from 'svelte';
  import { refusalStatus } from '$lib/utils/apiRefusal';
  import { Log } from '$lib/utils/Log';
  import { createProductCheckout, type AssociationProduct } from '$lib/associations/api';
  import { providerRefusalMessage } from '$lib/associations/paymentRefusal';
  import { isMobileTauri, shopCheckoutCallbacks } from '$lib/utils/checkoutCallbacks';
  import { watchReturnsToApp, type OnceReader } from '$lib/forms/checkoutReturn';
  import {
    checkoutReturnText,
    createShopCheckoutReader,
    type CheckoutReturnView,
  } from '$lib/shop/checkoutReturn';
  import { showToast } from '$lib/stores/toast.svelte';
  import PayerEmailPrompt from '$lib/components/payments/PayerEmailPrompt.svelte';
  import {
    activePaymentProvider,
    loadActivePaymentProvider,
  } from '$lib/associations/activePaymentProvider.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    product: AssociationProduct;
    /** Custom amount in cents when the product allows a free-form price. */
    customAmountCents?: number;
    /** Override the default action label (Cotiser / Recharger / Acheter). */
    label?: string;
    class?: string;
    disabled?: boolean;
  }

  let {
    product,
    customAmountCents,
    label,
    class: className = '',
    disabled = false,
  }: Props = $props();

  let checkingOut = $state(false);
  let askingPayerEmail = $state(false);

  /**
   * The purchase this phone handed to Lydia's page (the system browser): the page cannot know the
   * payer came back, so it keeps the attempt, says it is in progress and reads it ONCE each time
   * the app returns to the screen (`watchReturnsToApp`). Its reader is the attempt's identity: a
   * read that lands after a newer purchase replaced it is dropped.
   */
  let pending = $state.raw<{
    checkoutUrl: string;
    reader: OnceReader<CheckoutReturnView>;
  } | null>(null);
  /** What the last read of the attempt ended on, once final. */
  let settled = $state<CheckoutReturnView | null>(null);

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
        (customAmountCents == null || customAmountCents <= 0))
  );

  onMount(() => {
    void loadActivePaymentProvider();
  });

  // While a purchase is pending, each return of the app to the screen reads it once.
  $effect(() => {
    if (!pending) return;
    return watchReturnsToApp(() => {
      void readPending();
    });
  });

  /** ONE read of the pending attempt; only an outcome about the attempt still shown is applied. */
  async function readPending(): Promise<void> {
    const attempt = pending;
    if (!attempt) return;
    let view: CheckoutReturnView | null;
    try {
      view = await attempt.reader.readOnce();
    } catch (err) {
      // Unknown is not a verdict: the note stays and the next return asks again.
      console.warn(
        `[ProductPurchase] could not read the pending purchase status=${refusalStatus(err) ?? 'transport'}`,
        err
      );
      return;
    }
    if (view === null || pending !== attempt) return;
    Log.d('ProductPurchase', `pending purchase read: ${view}`);
    if (view === 'waiting') return;
    pending = null;
    settled = view;
  }

  /** Lydia's payer page again, for a payer who came back before confirming. */
  async function reopenCheckout(): Promise<void> {
    const url = pending?.checkoutUrl;
    if (!url) return;
    const { navigateExternal } = await import('$lib/utils/openExternal');
    await navigateExternal(url).catch((err: unknown) =>
      console.error('[ProductPurchase] reopening the payer page failed:', err)
    );
  }

  /** Resolves custom amount in cents when applicable. */
  function resolveCustomCents(): number | undefined {
    if (product.allowCustomAmount && product.amountCents === null) {
      if (customAmountCents == null || customAmountCents <= 0) return undefined;
      return customAmountCents;
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
    settled = null;
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
      if (isMobileTauri()) {
        Log.d('ProductPurchase', 'handed to Lydia, watching for the return to the app');
        pending = {
          checkoutUrl: res.checkoutUrl,
          reader: createShopCheckoutReader({
            associationId: product.associationId,
            productId: product.id,
            checkoutId: res.checkoutId,
          }),
        };
      }
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
  class="bg-accent text-on-accent hover:bg-accent-hover inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-bold transition-opacity disabled:cursor-not-allowed disabled:opacity-50 {className}"
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

{#if pending}
  <div class="mt-2 flex flex-col gap-1.5 text-xs" role="status" data-purchase-in-progress>
    <p class="text-amber-warn-text font-medium">{m.shop_payment_in_progress_note()}</p>
    <button
      type="button"
      class="text-accent-text self-start font-bold underline"
      onclick={() => void reopenCheckout()}
    >
      {m.form_view_payment_reopen()}
    </button>
  </div>
{:else if settled}
  <p class="text-text-muted mt-2 text-xs" role="status" data-purchase-outcome={settled}>
    {checkoutReturnText(settled, product.type)}
  </p>
{/if}
