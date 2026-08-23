<script lang="ts">
  import type { MembershipTier } from '$lib/associations/api';
  import Input from '$lib/components/ui/Input.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import {
    CONTROL_HINT_CLASS,
    CONTROL_LABEL_CLASS,
    controlClass,
  } from '$lib/components/ui/controlClasses';
  import StripeNetPayoutHint from '$lib/components/payments/StripeNetPayoutHint.svelte';
  import FormSection from './FormSection.svelte';
  import MemberPriceFields from './MemberPriceFields.svelte';
  import type { FormCotisationSettings } from '$lib/forms/cotisationSettings';
  import { Check, CreditCard } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * Everything about money: whether the form charges, how much, what a cotisant pays, and how the
   * payment can be made.
   *
   * WHO receives the money is not here. The association is chosen once, in the general section,
   * because a form belongs to an association whether or not it charges - and because that choice is
   * fixed at creation while everything in here can be changed forever.
   *
   * Both screens had their own copy of this and the copies had drifted in ways a user could see: two
   * different placeholders on the association picker, a select that had lost its focus ring, a
   * cash-expiry field that was a bare input on one screen and a labelled component on the other,
   * and two different toggle sizes on the same screen.
   */
  interface Props {
    /** Whether the form charges anything. */
    requiresPayment: boolean;
    /** Public base price, in euros. */
    basePrice: number;
    /** Whether cash is accepted alongside the card. */
    allowCashPayment: boolean;
    /** Days before an unvalidated cash submission expires. */
    cashPaymentExpiryDays: number | undefined;
    /** The cotisation settings, for the member-price block. */
    cotisation: FormCotisationSettings;
    /** The linked association's cotisation tiers. */
    tiers: MembershipTier[];
    /** The linked association's name; '' for a personal form. */
    associationName: string;
    /** Whether that association has finished Stripe onboarding and can actually be paid. */
    associationCanBePaid: boolean;
    /** Whether a member price can be offered (payment on, association chosen, tiers exist). */
    canOfferMemberPrice: boolean;
  }

  let {
    requiresPayment = $bindable(),
    basePrice = $bindable(),
    allowCashPayment = $bindable(),
    cashPaymentExpiryDays = $bindable(),
    cotisation = $bindable(),
    tiers,
    associationName,
    associationCanBePaid,
    canOfferMemberPrice,
  }: Props = $props();

  const showMemberPricing = $derived(requiresPayment && cotisation.memberPriceEnabled);

  /**
   * A paid form needs somewhere for the money to land. Said here, at the moment payment is switched
   * on, rather than left for the save to refuse - the association is chosen two sections up and the
   * reason it will not do is a payment reason.
   */
  const paymentBlocker = $derived.by(() => {
    if (!requiresPayment) return null;
    if (!associationName) return 'no-association';
    if (!associationCanBePaid) return 'no-stripe';
    return null;
  });
</script>

<FormSection title={m.form_section_payment()} icon={CreditCard}>
  <Toggle bind:checked={requiresPayment} label={m.form_requires_payment_label()} />

  {#if requiresPayment}
    {#if paymentBlocker}
      <div class="border-amber-warn/30 bg-amber-warn/10 space-y-2 rounded-2xl border-2 px-4 py-3">
        <p class="text-sm font-semibold text-amber-900 dark:text-amber-100">
          {paymentBlocker === 'no-association'
            ? m.form_payment_needs_association_title()
            : m.form_payment_needs_stripe_title({ association: associationName })}
        </p>
        <p class="text-xs text-amber-800/80 dark:text-amber-200/70">
          {paymentBlocker === 'no-association'
            ? m.form_payment_needs_association_desc()
            : m.form_payment_needs_stripe_desc()}
        </p>
        <button
          type="button"
          onclick={() => (requiresPayment = false)}
          class="inline-flex items-center gap-1.5 rounded-xl bg-amber-500/20 px-3 py-1.5 text-xs font-bold text-amber-900 transition-colors hover:bg-amber-500/30 dark:text-amber-100"
        >
          {m.form_no_stripe_create_free_button()}
        </button>
      </div>
    {/if}

    <div class="border-cn-border space-y-4 border-t-2 pt-4">
      <Input
        label={m.form_base_price_label()}
        type="number"
        bind:value={basePrice}
        min="0"
        step="0.01"
        placeholder="0.00"
      />
    </div>

    <MemberPriceFields bind:settings={cotisation} {tiers} available={canOfferMemberPrice} />

    <StripeNetPayoutHint
      grossEuros={basePrice}
      grossEurosMember={showMemberPricing ? cotisation.basePriceMember : ''}
      showOptionSupplementNote={true}
    />

    <div class="border-cn-border space-y-3 border-t-2 pt-4">
      <p class="text-text-main text-sm font-bold">{m.form_payment_methods_heading()}</p>
      <div
        class="border-cn-yellow bg-cn-yellow/5 flex items-center gap-4 rounded-2xl border-2 px-4 py-3.5"
      >
        <div
          class="bg-cn-yellow/20 text-cn-dark flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
        >
          <CreditCard size={20} />
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-text-main text-sm font-bold">{m.form_card_payment_label()}</p>
          <p class="text-text-muted text-xs">{m.form_card_payment_desc()}</p>
        </div>
        <div
          class="bg-cn-yellow/30 text-cn-dark flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold"
        >
          <Check size={12} strokeWidth={3} />
          {m.form_card_active_badge()}
        </div>
      </div>

      <Toggle bind:checked={allowCashPayment} label={m.form_cash_label()} />
      {#if allowCashPayment}
        <div>
          <label for="cash-expiry" class={CONTROL_LABEL_CLASS}>{m.form_cash_expiry_label()}</label>
          <input
            id="cash-expiry"
            type="number"
            bind:value={cashPaymentExpiryDays}
            min="1"
            placeholder={m.form_cash_expiry_placeholder()}
            class="{controlClass()} sm:w-48"
          />
          <p class={CONTROL_HINT_CLASS}>{m.form_cash_expiry_hint()}</p>
        </div>
      {/if}
    </div>
  {/if}
</FormSection>
