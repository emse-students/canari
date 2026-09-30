<script lang="ts">
  import type { FormItem, FormOption } from '$lib/forms/api';
  import { formatAmount } from '$lib/forms/fillAnswers';
  import Picker from '$lib/components/ui/Picker.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import { Ban } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * ONE QUESTION OF A FORM BEING FILLED IN - its card, its label and the input its type calls for.
   *
   * It was 220 lines inline in `routes/forms/[id]/+page.svelte`, with the option row of a single
   * and a multiple choice written out twice. It knows nothing about pricing rules: the page says
   * what an option adds and whether it is closed, through the two callbacks, because only the page
   * holds the grid slice that decides it. A form with no grid passes neither.
   */
  interface Props {
    item: FormItem;
    /** Position in the list the reader sees, shown as the question number. */
    index: number;
    /** The answer, bound: a string, a number, an id list, or a row map for a matrix. */
    value: any;
    /** No input accepts a change - the form is sent, or not open yet. */
    disabled: boolean;
    /** Scopes the radio groups, so two forms on one screen never share a `name`. */
    formId: string;
    /** Currency the supplements are written in. */
    currency?: string;
    /** What choosing this option adds, in cents. Defaults to the option's own supplement. */
    optionModifier?: (item: FormItem, opt: FormOption) => number;
    /** Whether this option leads to a combination the form does not offer. Defaults to never. */
    optionClosed?: (opt: FormOption) => boolean;
  }

  let {
    item,
    index,
    value = $bindable(),
    disabled,
    formId,
    currency = 'eur',
    optionModifier = (_item, opt) => opt.priceModifier,
    optionClosed = () => false,
  }: Props = $props();

  /**
   * A dropdown's choices, each read as the option label plus what it changes: closed, or its
   * supplement. An option saved without an id falls back to its label, as a `<select>` did.
   */
  function dropdownOptions(): PickerOption[] {
    return (item.options ?? []).map((opt) => {
      const closed = optionClosed(opt);
      const modifier = optionModifier(item, opt);
      const suffix = closed
        ? ` - ${m.form_grid_cell_unavailable()}`
        : modifier > 0
          ? ` (+${formatAmount(modifier, currency)})`
          : modifier < 0
            ? ` (${formatAmount(modifier, currency)})`
            : '';
      return { value: opt.id ?? opt.label, label: `${opt.label}${suffix}`, disabled: closed };
    });
  }

  const scaleValues = $derived(
    Array.from(
      { length: (item.scale?.max || 5) - (item.scale?.min || 1) + 1 },
      (_, i) => (item.scale?.min || 1) + i
    )
  );
</script>

<!-- What an option says beside its label: closed, or the supplement it adds. Shown rather than
     hidden when closed: an option that vanishes reads as a bug, and the person needs to see the
     choice exists but is closed to them. -->
{#snippet optionBadge(opt: FormOption)}
  {#if optionClosed(opt)}
    <span
      class="text-text-muted bg-cn-border/50 flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold"
    >
      <Ban size={11} />{m.form_grid_cell_unavailable()}
    </span>
  {:else if optionModifier(item, opt) !== 0}
    <span class="text-cn-dark bg-cn-yellow/20 shrink-0 rounded-full px-2 py-0.5 text-xs font-bold">
      {optionModifier(item, opt) > 0 ? '+' : ''}{formatAmount(optionModifier(item, opt), currency)}
    </span>
  {/if}
{/snippet}

<div class="border-cn-border rounded-2xl border bg-(--cn-surface) p-5 shadow-sm">
  <!-- svelte-ignore a11y_label_has_associated_control -->
  <label class="mb-1.5 flex items-start gap-2">
    <span
      class="text-text-muted bg-cn-border/50 text-2xs mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 font-bold tabular-nums"
    >
      {index + 1}
    </span>
    <span class="text-text-main text-sm leading-snug font-bold">
      {item.label}
      {#if item.required}<span class="ml-0.5 text-red-500">*</span>{/if}
    </span>
  </label>

  {#if item.description}
    <p class="text-text-muted mb-3 ml-6 text-xs leading-relaxed">{item.description}</p>
  {/if}

  {#if item.imageUrl}
    <div class="border-cn-border/60 mb-3 ml-6 overflow-hidden rounded-xl border">
      <img src={item.imageUrl} alt="" class="max-h-48 w-full object-cover" loading="lazy" />
    </div>
  {/if}

  {#if item.type === 'short_text'}
    <input
      type="text"
      class="border-cn-border text-text-main bg-cn-bg placeholder:text-text-muted/50 focus:border-cn-yellow w-full rounded-2xl border-2 px-4 py-3 text-sm transition-all outline-none focus:shadow-[0_0_0_4px_rgba(250,204,21,0.12)] disabled:opacity-50"
      bind:value
      placeholder={m.form_view_answer_placeholder()}
      {disabled}
    />
  {:else if item.type === 'long_text'}
    <textarea
      rows="4"
      class="border-cn-border text-text-main bg-cn-bg placeholder:text-text-muted/50 focus:border-cn-yellow w-full resize-y rounded-2xl border-2 px-4 py-3 text-sm transition-all outline-none focus:shadow-[0_0_0_4px_rgba(250,204,21,0.12)] disabled:opacity-50"
      bind:value
      placeholder={m.form_view_answer_placeholder()}
      {disabled}></textarea>
  {:else if item.type === 'dropdown' || item.type === 'single'}
    <Picker
      value={value ?? ''}
      options={dropdownOptions()}
      label={item.label}
      placeholder={m.form_view_select_placeholder()}
      {disabled}
      triggerClass="border-cn-border text-text-main bg-cn-bg focus-visible:border-cn-yellow flex w-full items-center justify-between gap-2 rounded-2xl border-2 px-4 py-3 text-left text-sm transition-all outline-none focus-visible:shadow-[0_0_0_4px_rgba(250,204,21,0.12)] disabled:opacity-50"
      onValueChange={(v) => (value = v)}
    />
  {:else if item.type === 'single_choice' || item.type === 'multiple_choice'}
    {@const multiple = item.type === 'multiple_choice'}
    <div class="space-y-2">
      {#each item.options ?? [] as opt (opt.id)}
        {@const selected = multiple ? (value ?? []).includes(opt.id) : value === opt.id}
        <label
          class="flex cursor-pointer items-center gap-3 rounded-2xl border-2 px-4 py-3 transition-all select-none {selected
            ? 'border-cn-yellow bg-cn-yellow/8'
            : 'border-cn-border hover:border-cn-yellow/60 bg-cn-bg'} {disabled || optionClosed(opt)
            ? 'cursor-not-allowed opacity-60'
            : ''}"
        >
          {#if multiple}
            <input
              type="checkbox"
              value={opt.id}
              bind:group={value}
              class="accent-cn-yellow h-4 w-4 shrink-0 rounded"
              disabled={disabled || optionClosed(opt)}
            />
          {:else}
            <input
              type="radio"
              name={`radio-${formId}-${item.id}`}
              value={opt.id}
              bind:group={value}
              class="accent-cn-yellow h-4 w-4 shrink-0"
              disabled={disabled || optionClosed(opt)}
            />
          {/if}
          <span class="text-text-main flex-1 text-sm font-medium">{opt.label}</span>
          {@render optionBadge(opt)}
        </label>
      {/each}
    </div>
  {:else if item.type === 'linear_scale'}
    <div>
      <div class="text-text-muted mb-2 flex justify-between px-1 text-xs font-semibold">
        <span>{item.scale?.minLabel || item.scale?.min}</span>
        <span>{item.scale?.maxLabel || item.scale?.max}</span>
      </div>
      <div
        class="border-cn-border bg-cn-bg flex items-stretch gap-1 overflow-hidden rounded-2xl border-2"
      >
        {#each scaleValues as val (val)}
          <label
            class="flex flex-1 cursor-pointer flex-col items-center justify-center gap-1.5 py-3 transition-all select-none
 {value === val ? 'bg-cn-yellow/15' : 'hover:bg-cn-border/30'}
 {disabled ? 'cursor-not-allowed opacity-60' : ''}"
          >
            <input
              type="radio"
              name={`scale-${formId}-${item.id}`}
              value={val}
              bind:group={value}
              class="accent-cn-yellow h-4 w-4"
              {disabled}
            />
            <span class="text-text-muted text-xs font-bold">{val}</span>
          </label>
        {/each}
      </div>
    </div>
  {:else if item.type === 'matrix_single' || item.type === 'matrix_multiple'}
    <div class="border-cn-border overflow-x-auto rounded-2xl border-2">
      <table class="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr class="bg-cn-border/20">
            <th class="sticky left-0 z-10 w-1/3 min-w-30 bg-(--cn-surface) p-3"></th>
            {#each item.options ?? [] as col (col.id)}
              <th
                class="text-text-muted min-w-20 px-3 py-3 text-center text-xs font-bold tracking-wide uppercase"
                >{col.label}</th
              >
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each item.rows ?? [] as row (row)}
            <tr class="hover:bg-cn-border/10 transition-colors">
              <td
                class="text-text-main border-cn-border sticky left-0 z-10 border-t bg-(--cn-surface) px-3 py-3 text-sm font-medium"
                >{row}</td
              >
              {#each item.options ?? [] as col (col.id)}
                <td class="border-cn-border border-t py-3 text-center">
                  {#if item.type === 'matrix_single'}
                    <input
                      type="radio"
                      name={`matrix-${formId}-${item.id}-${row}`}
                      value={col.id}
                      bind:group={value[row]}
                      class="accent-cn-yellow h-4 w-4"
                      {disabled}
                    />
                  {:else}
                    <input
                      type="checkbox"
                      value={col.id}
                      bind:group={value[row]}
                      class="accent-cn-yellow h-4 w-4"
                      {disabled}
                    />
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="bg-red-err/10 text-red-err border-red-err/30 rounded-xl border p-3 text-xs">
      {m.form_view_unsupported_type({ type: item.type })}
    </div>
  {/if}
</div>
