<script lang="ts">
  import {
    computeLydiaFeeCents,
    computeLydiaNetPayoutCents,
    eurosInputToCents,
    fetchLydiaFeeSchedule,
    type LydiaFeeSchedule,
  } from '$lib/payments/lydiaFees';
  import { fetchActivePaymentProvider, type PaymentProviderId } from '$lib/associations/api';
  import { formatAmount } from '$lib/forms/fillAnswers';
  import { m } from '$lib/paraglide/messages';

  /**
   * Renders the payout estimate under the platform's Lydia fee schedule - see
   * `docs/wiki/lydia-contract-flux.md#the-payout-estimate`.
   *
   * Nothing is drawn until the active provider is KNOWN to be Lydia (`GET /api/payments/provider`):
   * an unknown provider (still loading, or the call failed) gets no estimate rather than a guessed
   * one, and `disabled` has no payout at all. The fees are the ones a global admin entered
   * (`GET /api/payments/lydia-fee-schedule`), VAT included; while none is entered the hint says the
   * estimate is not configured - never a default figure.
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

  // `undefined` while loading or failed (no hint), `null` when NOT CONFIGURED (the hint says so).
  let schedule = $state<LydiaFeeSchedule | null | undefined>(undefined);
  $effect(() => {
    fetchLydiaFeeSchedule()
      .then((s) => (schedule = s))
      .catch((err) => {
        console.warn('[Payments] Failed to load the fee schedule for the payout hint:', err);
      });
  });

  function computeNetPayoutCents(cents: number): number {
    return schedule ? computeLydiaNetPayoutCents(cents, schedule) : 0;
  }

  function lineFor(cents: number, label: string): string {
    const net = computeNetPayoutCents(cents);
    const fee = schedule ? computeLydiaFeeCents(cents, schedule) : 0;
    return m.payout_line_for({
      label,
      payment: formatAmount(cents, currency),
      net: formatAmount(net, currency),
      fee: formatAmount(fee, currency),
    });
  }
</script>

{#if provider === 'lydia' && schedule !== undefined && (grossCents || memberCents || minCents || maxCents)}
  <div
    class="border-amber-warn/30 bg-amber-warn/10 text-amber-warn-text space-y-1 rounded-xl border px-4 py-3 text-xs"
    role="note"
  >
    <p class="font-semibold">{m.payout_hint_title()}</p>
    {#if schedule === null}
      <p>{m.payout_hint_not_configured()}</p>
    {:else}
      <p class="text-amber-warn-text">{m.payout_hint_fees_note()}</p>
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
    {/if}
  </div>
{/if}
