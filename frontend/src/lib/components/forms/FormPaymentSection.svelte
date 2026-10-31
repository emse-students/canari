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
  import PayoutFeeHint from '$lib/components/payments/PayoutFeeHint.svelte';
  import FormSection from './FormSection.svelte';
  import PriceGridEditor from '$lib/components/pricing/PriceGridEditor.svelte';
  import { emptyMatrix, priceRange, type PriceMatrix } from '$lib/pricing/priceMatrix';
  import type { FormationOption } from '$lib/pricing/criteriaOptions';
  import { CreditCard } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { activePaymentProvider } from '$lib/associations/activePaymentProvider.svelte';
  import { onlinePaymentCopy } from '$lib/associations/paymentProviderCopy';

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
    /** An anonymous form cannot charge: a payment names its payer. */
    anonymous: boolean;
    /**
     * A public form CAN charge (WP-P1): a guest pays on Lydia's page with an e-mail it types. Only
     * its grid is narrowed - to answers, the one criterion a guest has.
     */
    isPublic: boolean;
    /** The single price, in euros. Still the only price for a form with no grid. */
    basePrice: number;
    /** Whether cash is accepted alongside online payment. */
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
    /** Whether that association has finished its payment setup and can actually be paid. */
    associationCanBePaid: boolean;
    /**
     * Whether the linked association's KIND sells at all (`kindHasSection(type, 'payments')`): a
     * list or an institution collects nothing, so no price is offered for its forms. A form that
     * already carries one stays readable, frozen.
     */
    associationSells?: boolean;
  }

  let {
    requiresPayment = $bindable(),
    anonymous,
    isPublic,
    basePrice = $bindable(),
    allowCashPayment = $bindable(),
    cashPaymentExpiryDays = $bindable(),
    priceMatrix = $bindable(),
    tiers,
    formations,
    items,
    associationName,
    associationCanBePaid,
    associationSells = true,
  }: Props = $props();

  /**
   * A paid form needs somewhere for the money to land. Said here, at the moment payment is switched
   * on, rather than left for the save to refuse - the association is chosen two sections up and the
   * reason it will not do is a payment reason.
   */
  const paymentBlocker = $derived.by(() => {
    if (!requiresPayment) return null;
    if (!associationName) return 'no-association';
    if (!associationCanBePaid) return 'not-ready';
    return null;
  });

  /** Whether the form carries a price today, whatever its kind - the only case a no-sale kind shows. */
  const hasPrice = $derived(requiresPayment || basePrice > 0 || priceMatrix != null);

  /** The online-payment row, worded for the provider that is KNOWN - never a default. */
  const onlineCopy = $derived(onlinePaymentCopy(activePaymentProvider.current));

  /** The cheapest and dearest cell, so the payout hint spans what the grid can actually charge. */
  const gridRange = $derived(priceRange(priceMatrix));
</script>

{#if associationSells || hasPrice}
  <fieldset disabled={!associationSells} class="m-0 min-w-0 border-0 p-0">
    <FormSection title={m.form_section_payment()} icon={CreditCard}>
      {#if !associationSells}
        <p class="text-text-muted text-sm">{m.form_payment_kind_no_sale()}</p>
      {/if}
      <Toggle
        bind:checked={requiresPayment}
        disabled={anonymous}
        label={m.form_requires_payment_label()}
        hint={anonymous ? m.form_payment_disabled_anonymous() : undefined}
      />

      {#if requiresPayment}
        {#if paymentBlocker}
          <div
            class="border-amber-warn/30 bg-amber-warn/10 space-y-2 rounded-2xl border-2 px-4 py-3"
          >
            <p class="text-sm font-semibold text-amber-900 dark:text-amber-100">
              {paymentBlocker === 'no-association'
                ? m.form_payment_needs_association_title()
                : m.form_payment_needs_setup_title({ association: associationName })}
            </p>
            <p class="text-xs text-amber-800/80 dark:text-amber-200/70">
              {paymentBlocker === 'no-association'
                ? m.form_payment_needs_association_desc()
                : m.form_payment_needs_setup_desc()}
            </p>
            <button
              type="button"
              onclick={() => (requiresPayment = false)}
              class="inline-flex items-center gap-1.5 rounded-xl bg-amber-500/20 px-3 py-1.5 text-xs font-bold text-amber-900 transition-colors hover:bg-amber-500/30 dark:text-amber-100"
            >
              {m.form_no_payments_create_free_button()}
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
            answersOnly={isPublic}
          />
        {/if}

        <PayoutFeeHint
          grossEuros={priceMatrix ? (gridRange?.max ?? 0) : basePrice}
          grossEurosMember={gridRange && gridRange.min !== gridRange.max ? gridRange.min : ''}
          showOptionSupplementNote={true}
        />

        <div class="border-cn-border space-y-3 border-t-2 pt-4">
          <p class="text-text-main text-sm font-bold">{m.form_payment_methods_heading()}</p>
          <!-- ONE non-selectable line: online payment is Lydia ("Paiement Canari"), there is no
           provider to choose. Unavailable (a leftover stripe, or disabled) is said, not hidden. -->
          <div
            data-testid="online-payment-line"
            data-state={onlineCopy.state}
            class="flex items-center gap-4 rounded-2xl border-2 px-4 py-3.5 {onlineCopy.state ===
            'unavailable'
              ? 'border-amber-warn/30 bg-amber-warn/10'
              : 'border-cn-yellow bg-cn-yellow/5'}"
          >
            <div
              class="bg-cn-yellow/20 text-cn-dark flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
            >
              <CreditCard size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-text-main text-sm font-bold">{onlineCopy.label}</p>
              {#if onlineCopy.description}
                <p class="text-text-muted text-xs">{onlineCopy.description}</p>
              {/if}
            </div>
          </div>

          <Toggle bind:checked={allowCashPayment} label={m.form_cash_label()} />
          {#if allowCashPayment}
            <div>
              <label for="cash-expiry" class={CONTROL_LABEL_CLASS}
                >{m.form_cash_expiry_label()}</label
              >
              <input
                id="cash-expiry"
                type="number"
                bind:value={cashPaymentExpiryDays}
                min="1"
                required={isPublic}
                placeholder={m.form_cash_expiry_placeholder()}
                class="{controlClass()} sm:w-48"
              />
              <!-- A public form needs a deadline (the server refuses one without): a guest's unpaid cash
               answer holds its seat, and its visitor's place under the ceiling, until then. -->
              <p class={CONTROL_HINT_CLASS}>
                {isPublic ? m.form_cash_expiry_required_public() : m.form_cash_expiry_hint()}
              </p>
            </div>
          {/if}
        </div>
      {/if}
    </FormSection>
  </fieldset>
{/if}
