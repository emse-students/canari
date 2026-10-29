<script lang="ts">
  import { Delete } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import { Log } from '$lib/utils/Log';
  import {
    QUICK_AMOUNTS_CENTS,
    applyAmountKey,
    bufferToCents,
    centsToBuffer,
    currencySymbol,
    decimalSeparator,
    formatAmountCents,
    formatBuffer,
    type AmountKey,
  } from '$lib/shop/amountInput';

  interface Props {
    /** Chosen amount in cents; `undefined` while nothing valid is chosen (empty, or out of bounds). */
    valueCents?: number;
    /** The product's minimum in cents, when it has one. */
    minCents?: number | null;
    /** The product's maximum in cents, when it has one. The server validates either way, but a chip
     * or a typed amount above it would be refused on every press, so it is filtered/blocked here too. */
    maxCents?: number | null;
    currency: string;
  }

  let { valueCents = $bindable(), minCents = null, maxCents = null, currency }: Props = $props();

  const locale = getLocale();
  const KEYS: AmountKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', 'back'];

  let buffer = $state('');
  let keypadOpen = $state(false);

  const typedCents = $derived(bufferToCents(buffer));
  const belowMin = $derived(typedCents !== undefined && minCents != null && typedCents < minCents);
  const aboveMax = $derived(typedCents !== undefined && maxCents != null && typedCents > maxCents);
  const chips = $derived(
    QUICK_AMOUNTS_CENTS.filter(
      (cents) => (minCents == null || cents >= minCents) && (maxCents == null || cents <= maxCents)
    )
  );
  const display = $derived(
    keypadOpen
      ? `${formatBuffer(buffer, locale)} ${currencySymbol(currency, locale)}`
      : valueCents !== undefined
        ? formatAmountCents(valueCents, currency, locale)
        : formatAmountCents(0, currency, locale)
  );

  /** A chip is a decision: it sets the amount and closes the keypad. */
  function pickChip(cents: number) {
    Log.d('AmountPicker: quick amount chosen', { cents });
    keypadOpen = false;
    buffer = centsToBuffer(cents);
    valueCents = cents;
  }

  function openKeypad() {
    Log.d('AmountPicker: keypad opened');
    keypadOpen = true;
    buffer = valueCents !== undefined ? centsToBuffer(valueCents) : '';
  }

  function press(key: AmountKey) {
    buffer = applyAmountKey(buffer, key);
    const cents = bufferToCents(buffer);
    // Below the minimum or above the maximum is no amount at all: the purchase button stays
    // disabled and the hint says why, rather than offering a press the checkout would refuse.
    if (cents !== undefined && minCents != null && cents < minCents) {
      Log.d('AmountPicker: typed amount below the minimum', { cents, minCents });
      valueCents = undefined;
      return;
    }
    if (cents !== undefined && maxCents != null && cents > maxCents) {
      Log.d('AmountPicker: typed amount above the maximum', { cents, maxCents });
      valueCents = undefined;
      return;
    }
    valueCents = cents;
  }
</script>

<div class="flex flex-col gap-3">
  <p
    class="text-text-main text-center text-3xl font-bold tabular-nums"
    aria-live="polite"
    data-testid="amount-display"
  >
    {display}
  </p>

  <div class="flex flex-wrap justify-center gap-2">
    {#each chips as cents (cents)}
      {@const selected = !keypadOpen && valueCents === cents}
      <button
        type="button"
        aria-pressed={selected}
        onclick={() => pickChip(cents)}
        class="min-h-11 rounded-full border px-4 text-sm font-semibold transition-colors {selected
          ? 'bg-cn-yellow text-cn-ink border-transparent'
          : 'border-cn-border text-text-main hover:bg-cn-border/40'}"
      >
        {formatAmountCents(cents, currency, locale, true)}
      </button>
    {/each}
    <button
      type="button"
      aria-pressed={keypadOpen}
      onclick={openKeypad}
      class="min-h-11 rounded-full border px-4 text-sm font-semibold transition-colors {keypadOpen
        ? 'bg-cn-yellow text-cn-ink border-transparent'
        : 'border-cn-border text-text-main hover:bg-cn-border/40'}"
    >
      {m.shop_amount_other()}
    </button>
  </div>

  {#if keypadOpen}
    <div
      class="mx-auto grid w-full max-w-xs grid-cols-3 gap-2"
      role="group"
      aria-label={m.shop_amount_keypad()}
    >
      {#each KEYS as key (key)}
        <button
          type="button"
          onclick={() => press(key)}
          aria-label={key === 'back' ? m.shop_amount_backspace() : undefined}
          class="text-text-main hover:bg-cn-border/40 active:bg-cn-border/60 flex min-h-12 items-center justify-center rounded-xl text-xl font-semibold transition-colors"
        >
          {#if key === 'back'}
            <Delete class="h-5 w-5" aria-hidden="true" />
          {:else if key === ','}
            {decimalSeparator(locale)}
          {:else}
            {key}
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  {#if belowMin && minCents != null}
    <p class="text-center text-xs text-amber-700 dark:text-amber-400" role="status">
      {m.shop_amount_min_hint({ min: formatAmountCents(minCents, currency, locale) })}
    </p>
  {:else if aboveMax && maxCents != null}
    <p class="text-center text-xs text-amber-700 dark:text-amber-400" role="status">
      {m.shop_amount_max_hint({ max: formatAmountCents(maxCents, currency, locale) })}
    </p>
  {/if}
</div>
