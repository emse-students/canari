<!--
  What a holder of another cotisation tier pays to move up to this one, written as the sentence a
  person would say ("A holder of [tier] who moves up to X pays [15] EUR instead of 30 EUR") and
  previewed as the member will see it. Edits the stored pair `memberPriceTag` (through `fromTag`,
  the source tier's tag) + `amountCentsMember` (through `riseEuros`); switched off, both are empty
  and the editor SAYS that every holder then pays the full price - nothing computes a complement.
-->
<script lang="ts">
  import Picker from '$lib/components/ui/Picker.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import {
    defaultRiseSource,
    eurosToCents,
    riseGivesNoDiscount,
    riseSentence,
    riseSourceTier,
    tierPriceLabel,
    type RiseQuote,
    type TierLike,
  } from '$lib/associations/cotisationTiers';
  import { formatAmount } from '$lib/forms/fillAnswers';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  interface Props {
    /** Prefix of the element ids, unique per form. */
    idPrefix: string;
    /** The tier being edited, as its label reads now. */
    toName: string;
    /** Its full price as typed now, or null when none is set. */
    fullCents: number | null;
    /** The other tiers a holder may rise from, in reading order (`riseSources`). */
    sources: TierLike[];
    /** The source tier's granted tag; empty means no preferential price. */
    fromTag: string;
    /** The preferential price in euros, empty when not set. */
    riseEuros: number | '';
  }

  let {
    idPrefix,
    toName,
    fullCents,
    sources,
    fromTag = $bindable(),
    riseEuros = $bindable(),
  }: Props = $props();

  const enabled = $derived(fromTag !== '');
  const fromOptions = $derived<PickerOption[]>(
    sources.map((t) => ({ value: t.grantedTagName ?? '', label: t.name }))
  );
  const quote = $derived<RiseQuote>({
    fromName: enabled
      ? (riseSourceTier(sources, fromTag)?.name ?? m.asso_cotisations_rise_from_unknown())
      : null,
    toName,
    fullCents,
    riseCents: enabled ? eurosToCents(riseEuros) : null,
  });

  /** Switches the preferential price on (from the likeliest source tier) or off (both emptied). */
  function toggle(on: boolean) {
    const source = on ? defaultRiseSource(sources, fullCents) : null;
    Log.d('ASSO', `tier rise price ${on ? 'on' : 'off'}, ${sources.length} source tier(s)`);
    fromTag = source?.grantedTagName ?? '';
    if (!on) riseEuros = '';
  }
</script>

<div class="border-cn-border/70 space-y-3 rounded-xl border p-3">
  <label class="flex cursor-pointer items-start gap-2">
    <input
      type="checkbox"
      checked={enabled}
      disabled={sources.length === 0}
      onchange={(e) => toggle(e.currentTarget.checked)}
      class="accent-cn-yellow mt-0.5 size-4"
    />
    <span>
      <span class="text-text-main block text-xs font-semibold">
        {m.asso_cotisations_rise_toggle_label()}
      </span>
      <span class="text-text-muted block text-xs">{m.asso_cotisations_rise_toggle_hint()}</span>
    </span>
  </label>

  {#if enabled}
    <div class="text-text-main flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
      <span>{m.asso_cotisations_rise_sentence_holder()}</span>
      <div class="min-w-40">
        <Picker
          id="{idPrefix}-rise-from"
          value={fromTag}
          options={fromOptions}
          onValueChange={(v) => (fromTag = v)}
          label={m.asso_cotisations_rise_from_aria()}
          variant="field"
          density="compact"
        />
      </div>
      <span>{m.asso_cotisations_rise_sentence_moves_to()}</span>
      <strong class="font-semibold">{toName}</strong>
      <span>{m.asso_cotisations_rise_sentence_pays()}</span>
      <input
        id="{idPrefix}-rise-amount"
        type="number"
        min="0"
        step="0.01"
        inputmode="decimal"
        bind:value={riseEuros}
        aria-label={m.asso_cotisations_rise_amount_aria()}
        class="border-cn-border w-24 rounded-xl border bg-transparent px-3 py-2 text-sm tabular-nums"
      />
      <span>{m.asso_cotisations_rise_sentence_instead({ full: tierPriceLabel(fullCents) })}</span>
    </div>
    {#if riseGivesNoDiscount(quote)}
      <p class="text-amber-warn text-xs font-semibold">{m.asso_cotisations_rise_no_discount()}</p>
    {/if}
  {/if}

  <!-- The preview: the sentence, and the line the member would read in the shop. -->
  <div class="bg-cn-surface space-y-2 rounded-xl p-3">
    <p class="text-text-muted text-xs font-bold tracking-wide uppercase">
      {m.asso_cotisations_rise_preview_title()}
    </p>
    <p class="text-text-main text-sm">{riseSentence(quote)}</p>
    {#if quote.fromName !== null && quote.riseCents !== null && !riseGivesNoDiscount(quote)}
      <div class="border-cn-border bg-cn-bg rounded-lg border px-3 py-2">
        <p class="text-text-muted text-xs">
          {m.asso_cotisations_rise_preview_card_caption({ from: quote.fromName })}
        </p>
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-text-main truncate text-sm font-semibold">{toName}</span>
          <span class="shrink-0 tabular-nums">
            <span class="text-text-main text-sm font-bold">{formatAmount(quote.riseCents)}</span>
            {#if quote.fullCents !== null}
              <span class="text-text-muted ml-1 text-xs line-through"
                >{formatAmount(quote.fullCents)}</span
              >
            {/if}
          </span>
        </div>
      </div>
    {/if}
  </div>
</div>
