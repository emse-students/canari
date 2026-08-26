<script lang="ts">
  import type { MembershipTier } from '$lib/associations/api';
  import type { FormItem } from '$lib/forms/api';
  import Input from '$lib/components/ui/Input.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import {
    CONTROL_HINT_CLASS,
    CONTROL_LABEL_CLASS,
    controlClass,
  } from '$lib/components/ui/controlClasses';
  import StripeNetPayoutHint from '$lib/components/payments/StripeNetPayoutHint.svelte';
  import FormSection from './FormSection.svelte';
  import PriceGridEditor from './PriceGridEditor.svelte';
  import { emptyMatrix, priceRange, type PriceMatrix } from '$lib/forms/priceMatrix';
  import type { FormationOption } from '$lib/forms/criteriaOptions';
  import { Check, CreditCard } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * Everything about money: whether the form charges, how much, who pays what, and how.
   *
   * WHO receives the money is not here. The association is chosen once, in the general section,
   * because a form belongs to an association whether or not it charges - and because that choice is
   * fixed at creation while everything in here can be changed forever.
   *
   * The "cotisants pay less" block used to be its own component with its own tier picker. It is now
   * one criterion of the pricing grid, because a form needs to discriminate on more than membership
   * and two mechanisms for "some people pay less" is the gas factory this module was cleaned out of.
   *
   * A paid form is priced ONE way or the OTHER, chosen by a switch: a single public price, or the
   * grid. Both used to be on screen at once, with the single price relabelled "prix par defaut" and
   * used by nothing once a criterion existed - a field that looks live and decides nothing is a
   * field a manager tunes and then wonders about.
   */
  interface Props {
    /** Whether the form charges anything. */
    requiresPayment: boolean;
    /** The single price, in euros. Still the only price for a form with no grid. */
    basePrice: number;
    /** Whether cash is accepted alongside the card. */
    allowCashPayment: boolean;
    /** Days before an unvalidated cash submission expires. */
    cashPaymentExpiryDays: number | undefined;
    /** The pricing grid; null when the form has one price for everybody. */
    priceMatrix: PriceMatrix | null;
    /** The linked association's cotisation tiers, for the cotisation criterion. */
    tiers: MembershipTier[];
    /** Formation values in use, for the formation criterion. */
    formations: FormationOption[];
    /** The form's questions, for a criterion built on an answer. */
    items: FormItem[];
    /** The linked association's name; '' for a personal form. */
    associationName: string;
    /** Whether that association has finished Stripe onboarding and can actually be paid. */
    associationCanBePaid: boolean;
  }

  let {
    requiresPayment = $bindable(),
    basePrice = $bindable(),
    allowCashPayment = $bindable(),
    cashPaymentExpiryDays = $bindable(),
    priceMatrix = $bindable(),
    tiers,
    formations,
    items,
    associationName,
    associationCanBePaid,
  }: Props = $props();

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

  /** The cheapest and dearest cell, so the payout hint spans what the grid can actually charge. */
  const gridRange = $derived(priceRange(priceMatrix));
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
      <!-- Switching the grid on seeds it from the price on screen, and switching it off drops it -
           there is no third state where both are half-live. -->
      <Toggle
        label={m.form_price_mode_grid_label()}
        hint={m.form_price_mode_grid_hint()}
        bind:checked={
          () => priceMatrix != null,
          (on) => {
            priceMatrix = on ? emptyMatrix(basePrice) : null;
          }
        }
      />

      {#if !priceMatrix}
        <Input
          label={m.form_base_price_label()}
          type="number"
          bind:value={basePrice}
          min="0"
          step="0.01"
          placeholder="0.00"
        />
      {/if}
    </div>

    {#if priceMatrix}
      <PriceGridEditor
        bind:matrix={priceMatrix}
        {basePrice}
        {tiers}
        {formations}
        {items}
        hasCotisation={tiers.length > 0}
      />
    {/if}

    <StripeNetPayoutHint
      grossEuros={priceMatrix ? (gridRange?.max ?? 0) : basePrice}
      grossEurosMember={gridRange && gridRange.min !== gridRange.max ? gridRange.min : ''}
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
