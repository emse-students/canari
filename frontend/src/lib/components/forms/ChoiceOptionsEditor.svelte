<script lang="ts">
  import Input from '$lib/components/ui/Input.svelte';
  import { Plus, X } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * THE OPTIONS OF A CHOICE QUESTION (single choice, checkboxes, drop-down), each with its price
   * supplement when the form takes payment. Drawn by the question card AND by the add wizard's
   * second step, so the two edit the options the same way (owner, 2026-11-07).
   */
  interface Props {
    /** The question, mutated in place: its `options` are what this edits. */
    item: { id?: string; options?: { id?: string; label: string; priceModifier?: number }[] };
    /** Whether an option may carry a price supplement. */
    showPriceModifier?: boolean;
    /**
     * True when the pricing grid discriminates on THIS question's answer. Its per-option modifiers
     * are then hidden rather than shown and ignored: the grid cell already carries the choice, and
     * an input that changes no price is worse than no input.
     */
    pricedByGrid?: boolean;
  }

  let { item, showPriceModifier = false, pricedByGrid = false }: Props = $props();

  const priced = $derived(showPriceModifier && !pricedByGrid);

  const fieldClass =
    'w-full min-w-0 px-3 py-2.5 sm:px-4 sm:py-3 border-2 border-cn-border sm:border-black/10 dark:sm:border-white/10 rounded-xl sm:rounded-2xl text-sm sm:text-base text-text-main bg-(--cn-surface) outline-none transition-all placeholder:text-text-muted/50 focus:border-cn-yellow focus:shadow-[0_0_0_4px_rgba(250,204,21,0.15)]';

  function addOption() {
    item.options = [
      ...(item.options ?? []),
      { id: crypto.randomUUID(), label: '', priceModifier: undefined },
    ];
    Log.d('ChoiceOptionsEditor', `option added, ${item.options.length} now`);
  }

  function removeOption(idx: number) {
    if (!item.options) return;
    item.options = item.options.filter((_, i) => i !== idx);
  }
</script>

<div class="space-y-3 sm:space-y-4" data-testid="choice-options-editor">
  <div class="flex flex-col gap-0.5 sm:flex-row sm:items-end sm:justify-between">
    <h4 class="text-text-main text-xs font-bold opacity-80">
      {m.form_builder_options_header()}
    </h4>
    {#if priced}
      <div class="text-text-muted text-2xs flex gap-2 font-semibold sm:text-xs">
        <span class="w-20 text-right">{m.form_builder_price_public_header()}</span>
      </div>
    {/if}
  </div>

  {#if pricedByGrid}
    <p
      class="border-cn-yellow/40 bg-cn-yellow/5 text-text-muted rounded-xl border px-3 py-2 text-xs"
    >
      {m.form_builder_priced_by_grid()}
    </p>
  {/if}

  <div class="space-y-2 sm:space-y-2.5">
    {#each item.options ?? [] as opt, idx (opt.id)}
      <div
        class="rounded-xl border border-black/5 bg-black/[0.02] p-2.5 sm:rounded-none sm:border-0 sm:bg-transparent sm:p-0 dark:border-white/10 dark:bg-white/[0.02]"
      >
        <div class="mb-2 flex items-center justify-between gap-2 sm:hidden">
          <span class="text-text-muted text-2xs font-bold">
            {m.form_builder_option_mobile_label()}
            {idx + 1}
          </span>
          <button
            class="ui-icon-button text-text-muted rounded-lg transition-colors hover:bg-red-500/10 hover:text-red-500"
            onclick={() => removeOption(idx)}
            type="button"
            title={m.common_delete_button()}
            aria-label={m.form_builder_option_remove_aria()}
          >
            <X size={16} />
          </button>
        </div>

        <!-- Desktop: horizontal row -->
        <div class="group/opt hidden items-center gap-2 sm:flex">
          <span class="text-text-muted w-5 shrink-0 text-center font-mono text-xs opacity-60">
            {idx + 1}.
          </span>
          <div class="min-w-0 flex-1">
            <Input placeholder={m.form_builder_option_placeholder()} bind:value={opt.label} />
          </div>
          {#if priced}
            <div class="w-20 shrink-0">
              <Input
                type="number"
                placeholder="0.00"
                bind:value={opt.priceModifier}
                step="0.01"
                min="0"
              />
            </div>
          {/if}
          <button
            class="ui-icon-button text-text-muted rounded-xl transition-colors hover:bg-red-500/10 hover:text-red-500"
            onclick={() => removeOption(idx)}
            type="button"
            title={m.form_builder_option_remove_aria()}
          >
            <X size={18} />
          </button>
        </div>

        <!-- Mobile: full-width field -->
        <div class="space-y-2 sm:hidden">
          <input
            type="text"
            bind:value={opt.label}
            placeholder={m.form_builder_option_placeholder()}
            class={fieldClass}
          />
          {#if priced}
            <div>
              <label for="opt-price-{opt.id}" class="text-text-muted text-2xs mb-1 block font-bold"
                >{m.form_builder_price_public_mobile()}</label
              >
              <input
                id="opt-price-{opt.id}"
                type="number"
                bind:value={opt.priceModifier}
                step="0.01"
                min="0"
                placeholder="0.00"
                class={fieldClass}
              />
            </div>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <button
    class="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-amber-500/30 px-3 py-2.5 text-sm font-bold text-amber-600 transition-colors hover:bg-amber-500/10 hover:text-amber-500 sm:w-auto sm:justify-start sm:border-0 sm:py-2 dark:text-amber-500 dark:hover:text-amber-400"
    onclick={addOption}
    type="button"
  >
    <Plus size={18} strokeWidth={2.5} />
    {m.form_builder_add_option()}
  </button>
</div>
