<script lang="ts">
  import {
    computeLydiaNetPayoutCents,
    eurosInputToCents,
    fetchLydiaFeeSchedule,
    type LydiaFeeSchedule,
  } from '$lib/payments/lydiaFees';
  import { fetchActivePaymentProvider, type PaymentProviderId } from '$lib/associations/api';
  import { formatAmount } from '$lib/forms/fillAnswers';
  import { m } from '$lib/paraglide/messages';

  /**
   * Renders, for a price editor, the price the payer pays and - smaller, beneath - what the
   * association receives after the platform's Lydia fees (owner, 2026-11-14: no "approximately"; the
   * net is exact for the configured schedule). The payer never sees a fee: only the price paid - see
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
  // A reader refused the schedule gets no hint (`fetchLydiaFeeSchedule` logged it once).
  $effect(() => {
    fetchLydiaFeeSchedule()
      .then((s) => {
        if (s !== 'not-a-price-editor') schedule = s;
      })
      .catch((err) => {
        console.warn('[Payments] Failed to load the fee schedule for the payout hint:', err);
      });
  });

  function netCents(cents: number): number {
    return schedule ? computeLydiaNetPayoutCents(cents, schedule) : 0;
  }
</script>

{#if provider === 'lydia' && schedule !== undefined && (grossCents || memberCents || minCents || maxCents)}
  <div
    class="border-amber-warn/30 bg-amber-warn/10 text-amber-warn-text space-y-2 rounded-xl border px-4 py-3 text-xs"
    role="note"
  >
    <p class="font-semibold">{m.payout_hint_title()}</p>
    {#if schedule === null}
      <p>{m.payout_hint_not_configured()}</p>
    {:else}
      {#snippet paidAndNet(paid: string, net: string)}
        <div>
          <p class="font-semibold">{paid}</p>
          <p class="text-2xs opacity-80">{net}</p>
        </div>
      {/snippet}
      {#if grossCents}
        {@render paidAndNet(
          m.payout_paid_line({
            label: m.payout_label_public(),
            payment: formatAmount(grossCents, currency),
          }),
          m.payout_net_line({ net: formatAmount(netCents(grossCents), currency) })
        )}
      {/if}
      {#if memberCents}
        {@render paidAndNet(
          m.payout_paid_line({
            label: m.payout_label_member(),
            payment: formatAmount(memberCents, currency),
          }),
          m.payout_net_line({ net: formatAmount(netCents(memberCents), currency) })
        )}
      {/if}
      {#if minCents && maxCents}
        {@render paidAndNet(
          m.payout_free_paid_range({
            min: formatAmount(minCents, currency),
            max: formatAmount(maxCents, currency),
          }),
          m.payout_net_range({
            min: formatAmount(netCents(minCents), currency),
            max: formatAmount(netCents(maxCents), currency),
          })
        )}
      {:else if minCents}
        {@render paidAndNet(
          m.payout_free_paid_min({ payment: formatAmount(minCents, currency) }),
          m.payout_net_line({ net: formatAmount(netCents(minCents), currency) })
        )}
      {:else if maxCents}
        {@render paidAndNet(
          m.payout_free_paid_max({ payment: formatAmount(maxCents, currency) }),
          m.payout_net_line({ net: formatAmount(netCents(maxCents), currency) })
        )}
      {/if}
      {#if showOptionSupplementNote && (grossCents || memberCents)}
        <p>{m.payout_option_note()}</p>
      {/if}
      <p class="text-2xs opacity-80">{m.payout_hint_fees_note()}</p>
    {/if}
  </div>
{/if}
