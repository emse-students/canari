<script lang="ts">
  import {
    computeStripeCardFeeCents,
    STRIPE_CARD_FEE_FIXED_CENTS,
    eurosInputToCents,
  } from '$lib/payments/stripeFees';
  import { computeLydiaFeeCents, LYDIA_FEE_FIXED_CENTS } from '$lib/payments/lydiaFees';
  import { fetchActivePaymentProvider, type PaymentProviderId } from '$lib/associations/api';
  import { formatPriceCents } from '$lib/utils/canariLinkPreviewFormat';
  import { m } from '$lib/paraglide/messages';

  /**
   * Renders the payout estimate under whichever fee schedule is actually active - see
   * `docs/wiki/frontend/modules/payments.md#where-a-providers-name-may-appear-and-where-it-may-not`.
   *
   * This component USED TO be `StripeNetPayoutHint`, and the name was deliberate: the arithmetic
   * really was Stripe's, so a neutral name would have been the lie. It is neutral now because the
   * arithmetic itself picks a side at runtime - `stripeFees.ts` and `lydiaFees.ts` each stay
   * provider-specific (correctly), and this component is the seam that chooses between them, the
   * cheaper of the two options `docs/wiki/backlog.md` already named: ask
   * `GET /api/payments/provider` rather than have `PaymentProvider` expose its own schedule.
   */
  interface Props {
    /** Gross price in euros from a number input. */
    grossEuros?: number | '';
    /** Optional cotisant tier in euros. */
    grossEurosMember?: number | '';
    /** Custom-amount minimum in euros (products). */
    minEuros?: number | '';
    /** Custom-amount maximum in euros (products). */
    maxEuros?: number | '';
    currency?: string;
    /** When true, mentions that form option surcharges increase the gross amount. */
    showOptionSupplementNote?: boolean;
  }

  const props: Props = $props();
  const currency = $derived((props.currency ?? 'eur').toLowerCase());
  const showOptionSupplementNote = $derived(props.showOptionSupplementNote ?? false);

  const grossCents = $derived(eurosInputToCents(props.grossEuros));
  const memberCents = $derived(eurosInputToCents(props.grossEurosMember));
  const minCents = $derived(eurosInputToCents(props.minEuros));
  const maxCents = $derived(eurosInputToCents(props.maxEuros));

  // Server config, not per-association - fetched once and defaulted to `stripe` on failure, the
  // same posture the association edit page already takes for the same call.
  let provider = $state<PaymentProviderId>('stripe');
  $effect(() => {
    fetchActivePaymentProvider()
      .then((p) => (provider = p))
      .catch((err) => {
        console.warn('[Payments] Failed to load active provider for the payout hint:', err);
      });
  });

  const computeFeeCents = $derived(
    provider === 'lydia' ? computeLydiaFeeCents : computeStripeCardFeeCents
  );
  const feeFixedCents = $derived(
    provider === 'lydia' ? LYDIA_FEE_FIXED_CENTS : STRIPE_CARD_FEE_FIXED_CENTS
  );
  const feePercent = $derived(provider === 'lydia' ? 1 : 1.5);

  function computeNetPayoutCents(cents: number): number {
    return Math.max(0, cents - computeFeeCents(cents));
  }

  const feeLabel = $derived(`${formatPriceCents(feeFixedCents, currency)} + ${feePercent} %`);

  function lineFor(cents: number, label: string): string {
    const net = computeNetPayoutCents(cents);
    const fee = computeFeeCents(cents);
    return m.payout_line_for({
      label,
      payment: formatPriceCents(cents, currency),
      net: formatPriceCents(net, currency),
      fee: formatPriceCents(fee, currency),
    });
  }
</script>

{#if grossCents || memberCents || minCents || maxCents}
  <div
    class="space-y-1 rounded-xl border border-amber-200/80 bg-amber-50/70 px-4 py-3 text-xs text-amber-950/90 dark:border-amber-800/40 dark:bg-amber-950/20 dark:text-amber-100/90"
    role="note"
  >
    <p class="font-semibold">{m.payout_hint_title()}</p>
    <p class="text-amber-900/80 dark:text-amber-200/80">
      {m.payout_hint_fees_note({ feeLabel })}
    </p>
    {#if grossCents}
      <p>{lineFor(grossCents, m.payout_label_public())}</p>
    {/if}
    {#if memberCents}
      <p>{lineFor(memberCents, m.payout_label_member())}</p>
    {/if}
    {#if minCents && maxCents}
      <p>
        {m.payout_free_amount_range({
          min: formatPriceCents(computeNetPayoutCents(minCents), currency),
          max: formatPriceCents(computeNetPayoutCents(maxCents), currency),
          minPayment: formatPriceCents(minCents, currency),
          maxPayment: formatPriceCents(maxCents, currency),
        })}
      </p>
    {:else if minCents}
      <p>
        {m.payout_free_amount_min({
          payment: formatPriceCents(minCents, currency),
          net: formatPriceCents(computeNetPayoutCents(minCents), currency),
        })}
      </p>
    {:else if maxCents}
      <p>
        {m.payout_free_amount_max({
          payment: formatPriceCents(maxCents, currency),
          net: formatPriceCents(computeNetPayoutCents(maxCents), currency),
        })}
      </p>
    {/if}
    {#if showOptionSupplementNote && (grossCents || memberCents)}
      <p class="text-amber-900/70 dark:text-amber-200/60">
        {m.payout_option_note()}
      </p>
    {/if}
  </div>
{/if}
