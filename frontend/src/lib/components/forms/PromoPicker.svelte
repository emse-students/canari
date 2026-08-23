<script lang="ts">
  import { Plus, X } from '@lucide/svelte';
  import {
    CONTROL_HINT_CLASS,
    CONTROL_LABEL_CLASS,
    controlClass,
  } from '$lib/components/ui/controlClasses';
  import {
    FIRST_PROMO_YEAR,
    isPromoYear,
    lastPromoYear,
    promoYears,
  } from '$lib/forms/criteriaOptions';
  import { m } from '$lib/paraglide/messages';

  /**
   * The promos a criterion accepts: one box that is both a list and a free entry, a "+" that adds
   * what is in it, and a chip per promo added.
   *
   * A checkbox per promo was the first shape and it does not scale - a promo is an ENTRY year and
   * they run from 1816, so the control was either two hundred buttons or a five-year window, and the
   * window it shipped with was computed on the wrong reading of what a promo is: it offered six
   * cohorts nobody belonged to and left out the three largest that do. One text input with a
   * `datalist` covers the whole domain at a fixed size and is BOTH shapes at once: pick from the
   * list, or type the year when it is older than anything worth scrolling to. Years already added
   * are dropped from the list, so one cannot be picked twice.
   *
   * The "+" refuses a year outside the domain rather than letting the server say no later: `2O24`
   * typed for `2024` matches nobody for ever, and the same bound is enforced again server-side
   * (`FIRST_PROMO_YEAR` in `pricing/validate.ts`) because a client is not a guarantee.
   *
   * Used by BOTH promo surfaces - a group of the price grid and a "who may answer" condition - so
   * the two cannot disagree about what a promo is.
   */
  interface Props {
    /** Label above the control; omitted inside a grid group, which is already titled. */
    label?: string;
    /** Promos currently accepted. Rendered most recent first, whatever order they arrive in. */
    selected: number[];
    /** Called with the new list on every add and every removal. */
    onChange: (next: number[]) => void;
  }

  let { label, selected, onChange }: Props = $props();

  /** The year being typed or picked, as a string because that is what an input carries. */
  let draft = $state('');
  /** Ties the input to its own `datalist`; two pickers on one screen must not share a list. */
  const listId = $props.id();

  const shown = $derived([...selected].sort((a, b) => b - a));
  /** Every promo, minus the ones already added - a year cannot be accepted twice. */
  const available = $derived(promoYears().filter((y) => !selected.includes(y)));

  const draftYear = $derived(Number(draft.trim()));
  /** A year is addable when it is a real promo and not already in the list. */
  const canAdd = $derived(isPromoYear(draftYear) && !selected.includes(draftYear));
  /** Only complain about what has actually been typed - an empty box is not a mistake. */
  const showError = $derived(draft.trim().length > 0 && !canAdd);

  function add() {
    if (!canAdd) return;
    onChange([...selected, draftYear]);
    draft = '';
  }
</script>

<div class="space-y-2">
  {#if label}
    <p class={CONTROL_LABEL_CLASS}>{label}</p>
  {/if}

  {#if shown.length > 0}
    <div class="flex flex-wrap gap-2">
      {#each shown as year (year)}
        <span
          class="border-cn-border/70 text-text-main inline-flex items-center gap-1.5 rounded-xl border-2 bg-(--cn-surface) py-1 pr-1 pl-2.5 text-sm font-bold"
        >
          {year}
          <button
            type="button"
            onclick={() => onChange(selected.filter((y) => y !== year))}
            class="text-text-muted hover:bg-red-err/10 rounded-lg p-1 transition-colors hover:text-red-600"
            aria-label={m.form_promo_remove({ year })}
          >
            <X size={13} />
          </button>
        </span>
      {/each}
    </div>
  {:else}
    <p class={CONTROL_HINT_CLASS}>{m.form_promo_none()}</p>
  {/if}

  <div class="flex items-center gap-2">
    <input
      bind:value={draft}
      list={listId}
      inputmode="numeric"
      placeholder={m.form_promo_choose()}
      aria-label={m.form_promo_choose()}
      onkeydown={(e) => {
        // Enter adds the year; without this it submits the form the picker sits in.
        if (e.key === 'Enter') {
          e.preventDefault();
          add();
        }
      }}
      class="{controlClass(showError)} flex-1 py-2 text-sm"
    />
    <datalist id={listId}>
      {#each available as year (year)}
        <option value={String(year)}></option>
      {/each}
    </datalist>
    <button
      type="button"
      onclick={add}
      disabled={!canAdd}
      class="border-cn-border text-text-main hover:border-cn-yellow/40 inline-flex shrink-0 items-center gap-1.5 rounded-xl border-2 px-3 py-2 text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Plus size={13} />
      {m.form_promo_add()}
    </button>
  </div>

  {#if showError}
    <p class="text-xs font-semibold text-amber-900 dark:text-amber-100">
      {m.form_promo_invalid({ first: FIRST_PROMO_YEAR, last: lastPromoYear() })}
    </p>
  {/if}
</div>
