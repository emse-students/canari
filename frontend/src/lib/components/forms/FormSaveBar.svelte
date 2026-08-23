<script lang="ts">
  import { Save } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * The sticky-looking footer that says what will be saved and saves it.
   *
   * One copy for both screens: the create one centred its text on mobile and the edit one did not,
   * which is the kind of difference nobody chooses on purpose.
   */
  interface Props {
    /** Blocks saving and shows the "give it a title" hint instead of the summary. */
    titleMissing: boolean;
    /** Disables the button and swaps its label while a save is in flight. */
    isSubmitting: boolean;
    /** The summary line, e.g. "3 questions - 15 EUR". */
    summary: string;
    /** The button's label when idle. */
    saveLabel: string;
    /** Called when the button is pressed. */
    onSave: () => void;
  }

  let { titleMissing, isSubmitting, summary, saveLabel, onSave }: Props = $props();
</script>

<div
  class="border-cn-border/60 dark:bg-cn-ink/85 mt-5 flex flex-col items-center justify-center gap-3 rounded-2xl border bg-(--cn-surface)/85 px-4 py-3.5 text-center shadow-lg backdrop-blur-xl sm:flex-row sm:justify-between sm:px-5 sm:text-left"
>
  <p class="text-text-muted min-h-5 text-sm">
    {#if titleMissing}
      <span class="text-amber-warn font-medium">{m.form_title_required_hint()}</span>
    {:else}
      {summary}
    {/if}
  </p>
  <button
    onclick={onSave}
    disabled={isSubmitting || titleMissing}
    class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
  >
    <Save size={16} />
    {isSubmitting ? m.form_saving_label() : saveLabel}
  </button>
</div>
