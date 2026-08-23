<script lang="ts">
  import { Check } from '@lucide/svelte';
  import { CONTROL_HINT_CLASS, CONTROL_LABEL_CLASS } from './controlClasses';

  /**
   * A set of checkboxes over a fixed list of options, bound to the values that are ticked.
   *
   * The shape the pricing criteria are chosen with, which is what the request asked for - "des cases
   * a cocher" - and it is the honest control for a set: a multi-select listbox hides its own
   * contents, and a chip input invites a value nobody offers.
   */
  interface Option {
    /** What travels on the wire; never displayed. */
    value: string;
    /** What a person reads. */
    label: string;
    /** Optional second line - a count, or what a relative year resolves to today. */
    hint?: string;
  }

  interface Props {
    label?: string;
    options: Option[];
    /** The ticked values. */
    selected: string[];
    hint?: string;
    /** Shown in place of the list when there is nothing to offer. */
    emptyLabel?: string;
  }

  let { label, options, selected = $bindable(), hint, emptyLabel }: Props = $props();

  function toggle(value: string) {
    selected = selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
  }
</script>

<div>
  {#if label}<p class={CONTROL_LABEL_CLASS}>{label}</p>{/if}
  {#if options.length === 0}
    <p class="text-text-muted text-sm italic">{emptyLabel ?? ''}</p>
  {:else}
    <div class="flex flex-wrap gap-2">
      {#each options as option (option.value)}
        {@const on = selected.includes(option.value)}
        <button
          type="button"
          onclick={() => toggle(option.value)}
          aria-pressed={on}
          class="inline-flex items-center gap-2 rounded-xl border-2 px-3 py-2 text-left text-sm font-semibold transition-colors {on
            ? 'border-cn-yellow bg-cn-yellow/10 text-text-main'
            : 'border-cn-border text-text-muted hover:border-cn-yellow/40'}"
        >
          <span
            class="flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 {on
              ? 'border-cn-yellow bg-cn-yellow text-cn-ink'
              : 'border-cn-border'}"
          >
            {#if on}<Check size={11} strokeWidth={3} />{/if}
          </span>
          <span>
            {option.label}
            {#if option.hint}
              <span class="text-text-muted/70 block text-xs font-normal">{option.hint}</span>
            {/if}
          </span>
        </button>
      {/each}
    </div>
  {/if}
  {#if hint}<p class={CONTROL_HINT_CLASS}>{hint}</p>{/if}
</div>
