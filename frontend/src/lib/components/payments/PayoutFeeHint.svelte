<script lang="ts">
  import {
    computeLydiaFeeCents,
    LYDIA_FEE_FIXED_CENTS,
    eurosInputToCents,
  } from '$lib/payments/lydiaFees';
  import { fetchActivePaymentProvider, type PaymentProviderId } from '$lib/associations/api';
  import { formatAmount } from '$lib/forms/fillAnswers';
  import { m } from '$lib/paraglide/messages';

  /**
   * Renders the payout estimate under the Lydia fee schedule - see
   * `docs/wiki/frontend/modules/payments.md#where-a-providers-name-may-appear-and-where-it-may-not`.
   *
   * Nothing is drawn until the active provider is KNOWN to be Lydia: an unknown provider (still
   * loading, or the call failed) gets no estimate rather than a guessed one, and `disabled` has no
   * payout at all. The schedule is asked of `GET /api/payments/provider`, not assumed.
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

  // Server config, not per-association - fetched once. `null` (loading or failed) and `disabled`
  // both hide the hint: there is no schedule to apply and no payout to estimate.
  let provider = $state<PaymentProviderId | null>(null);
  $effect(() => {
    fetchActivePaymentProvider()
      .then((p) => (provider = p))
      .catch((err) => {
        console.warn('[Payments] Failed to load active provider for the payout hint:', err);
      });
  });

  const computeFeeCents = computeLydiaFeeCents;
  const feeFixedCents = LYDIA_FEE_FIXED_CENTS;
  const feePercent = 1;

  function computeNetPayoutCents(cents: number): number {
    return Math.max(0, cents - computeFeeCents(cents));
  }

  const feeLabel = $derived(`${formatAmount(feeFixedCents, currency)} + ${feePercent} %`);

  function lineFor(cents: number, label: string): string {
    const net = computeNetPayoutCents(cents);
    const fee = computeFeeCents(cents);
    return m.payout_line_for({
      label,
      payment: formatAmount(cents, currency),
      net: formatAmount(net, currency),
      fee: formatAmount(fee, currency),
    });
  }
</script>

{#if provider === 'lydia' && (grossCents || memberCents || minCents || maxCents)}
  <div
    class="border-amber-warn/30 bg-amber-warn/10 text-amber-warn-text space-y-1 rounded-xl border px-4 py-3 text-xs"
    role="note"
  >
    <p class="font-semibold">{m.payout_hint_title()}</p>
    <p class="text-amber-warn-text">
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
          min: formatAmount(computeNetPayoutCents(minCents), currency),
          max: formatAmount(computeNetPayoutCents(maxCents), currency),
          minPayment: formatAmount(minCents, currency),
          maxPayment: formatAmount(maxCents, currency),
        })}
      </p>
    {:else if minCents}
      <p>
        {m.payout_free_amount_min({
          payment: formatAmount(minCents, currency),
          net: formatAmount(computeNetPayoutCents(minCents), currency),
        })}
      </p>
    {:else if maxCents}
      <p>
        {m.payout_free_amount_max({
          payment: formatAmount(maxCents, currency),
          net: formatAmount(computeNetPayoutCents(maxCents), currency),
        })}
      </p>
    {/if}
    {#if showOptionSupplementNote && (grossCents || memberCents)}
      <p class="text-amber-warn-text">
        {m.payout_option_note()}
      </p>
    {/if}
  </div>
{/if}
