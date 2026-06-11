<script lang="ts">
  import {
    computeAssociationNetPayoutCents,
    computeStripeCardFeeCents,
    eurosInputToCents,
    STRIPE_CARD_FEE_FIXED_CENTS,
    STRIPE_CARD_FEE_PERCENT_BPS,
  } from '$lib/payments/stripeFees';
  import { formatPriceCents } from '$lib/utils/canariLinkPreviewFormat';

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
    return `${label} : paiement ${formatPriceCents(cents, currency)} → environ ${formatPriceCents(net, currency)} pour l'association (frais Stripe estimés ${formatPriceCents(fee, currency)}).`;
  }
</script>

{#if grossCents || memberCents || minCents || maxCents}
  <div
    class="rounded-xl border border-amber-200/80 bg-amber-50/70 dark:bg-amber-950/20 dark:border-amber-800/40 px-4 py-3 text-xs text-amber-950/90 dark:text-amber-100/90 space-y-1"
    role="note"
  >
    <p class="font-semibold">Versement estimé à l'association</p>
    <p class="text-amber-900/80 dark:text-amber-200/80">
      Frais Stripe indicatifs par paiement carte : {feeLabel}. Le montant réel peut varier selon le
      moyen de paiement.
    </p>
    {#if grossCents}
      <p>{lineFor(grossCents, 'Tarif public')}</p>
    {/if}
    {#if memberCents}
      <p>{lineFor(memberCents, 'Tarif cotisant')}</p>
    {/if}
    {#if minCents && maxCents}
      <p>
        Montant libre : entre {formatPriceCents(computeAssociationNetPayoutCents(minCents), currency)}
        et {formatPriceCents(computeAssociationNetPayoutCents(maxCents), currency)} pour l'association
        (pour des paiements de {formatPriceCents(minCents, currency)} à {formatPriceCents(maxCents, currency)}).
      </p>
    {:else if minCents}
      <p>
        Montant libre (min.) : paiement {formatPriceCents(minCents, currency)} → environ
        {formatPriceCents(computeAssociationNetPayoutCents(minCents), currency)} pour l'association.
      </p>
    {:else if maxCents}
      <p>
        Montant libre (max.) : paiement {formatPriceCents(maxCents, currency)} → environ
        {formatPriceCents(computeAssociationNetPayoutCents(maxCents), currency)} pour l'association.
      </p>
    {/if}
    {#if showOptionSupplementNote && (grossCents || memberCents)}
      <p class="text-amber-900/70 dark:text-amber-200/60">
        Les suppléments d'options du formulaire s'ajoutent au prix de base (frais recalculés sur le
        total payé).
      </p>
    {/if}
  </div>
{/if}
