<script lang="ts">
  import {
    computeAssociationNetPayoutCents,
    computeStripeCardFeeCents,
    eurosInputToCents,
    STRIPE_CARD_FEE_FIXED_CENTS,
    STRIPE_CARD_FEE_PERCENT_BPS,
  } from '$lib/payments/stripeFees';
  import { formatPriceCents } from '$lib/utils/canariLinkPreviewFormat';
  import { m } from '$lib/paraglide/messages';

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

  const feeLabel = $derived(
    `${formatPriceCents(STRIPE_CARD_FEE_FIXED_CENTS, currency)} + ${STRIPE_CARD_FEE_PERCENT_BPS / 100} %`
  );

  function lineFor(cents: number, label: string): string {
    const net = computeAssociationNetPayoutCents(cents);
    const fee = computeStripeCardFeeCents(cents);
    return m.stripe_payout_line_for({
      label,
      payment: formatPriceCents(cents, currency),
      net: formatPriceCents(net, currency),
      fee: formatPriceCents(fee, currency),
    });
  }
</script>

{#if grossCents || memberCents || minCents || maxCents}
  <div
    class="rounded-xl border border-amber-200/80 bg-amber-50/70 dark:bg-amber-950/20 dark:border-amber-800/40 px-4 py-3 text-xs text-amber-950/90 dark:text-amber-100/90 space-y-1"
    role="note"
  >
    <p class="font-semibold">{m.stripe_payout_hint_title()}</p>
    <p class="text-amber-900/80 dark:text-amber-200/80">
      {m.stripe_payout_hint_fees_note({ feeLabel })}
    </p>
    {#if grossCents}
      <p>{lineFor(grossCents, m.stripe_payout_label_public())}</p>
    {/if}
    {#if memberCents}
      <p>{lineFor(memberCents, m.stripe_payout_label_member())}</p>
    {/if}
    {#if minCents && maxCents}
      <p>{m.stripe_payout_free_amount_range({
        min: formatPriceCents(computeAssociationNetPayoutCents(minCents), currency),
        max: formatPriceCents(computeAssociationNetPayoutCents(maxCents), currency),
        minPayment: formatPriceCents(minCents, currency),
        maxPayment: formatPriceCents(maxCents, currency),
      })}</p>
    {:else if minCents}
      <p>{m.stripe_payout_free_amount_min({
        payment: formatPriceCents(minCents, currency),
        net: formatPriceCents(computeAssociationNetPayoutCents(minCents), currency),
      })}</p>
    {:else if maxCents}
      <p>{m.stripe_payout_free_amount_max({
        payment: formatPriceCents(maxCents, currency),
        net: formatPriceCents(computeAssociationNetPayoutCents(maxCents), currency),
      })}</p>
    {/if}
    {#if showOptionSupplementNote && (grossCents || memberCents)}
      <p class="text-amber-900/70 dark:text-amber-200/60">
        {m.stripe_payout_option_note()}
      </p>
    {/if}
  </div>
{/if}
