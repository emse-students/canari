<script lang="ts">
  import { Save, Send } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * The sticky-looking footer that says what will be saved and saves it - and, on a DRAFT, publishes
   * it (owner, 2026-11-08).
   *
   * One copy for both screens: the create one centred its text on mobile and the edit one did not,
   * which is the kind of difference nobody chooses on purpose.
   */
  interface Props {
    /** Blocks saving and shows the "give it a title" hint instead of the summary. */
    titleMissing: boolean;
    /** Disables the buttons and swaps the save label while a save is in flight. */
    isSubmitting: boolean;
    /** The summary line, e.g. "3 questions - 15 EUR". */
    summary: string;
    /** The save button's label when idle. */
    saveLabel: string;
    /** Called when the save button is pressed. */
    onSave: () => void;
    /**
     * The "Publier" action, offered while the form is a draft. `blockedReason` shuts it and is shown
     * beside it (a paid form whose association cannot collect yet); `busy` while it runs.
     */
    publish?: { onPublish: () => void; blockedReason: string | null; busy: boolean } | null;
  }

  let { titleMissing, isSubmitting, summary, saveLabel, onSave, publish = null }: Props = $props();
</script>

<div
  class="border-cn-border/60 bg-cn-surface mt-5 flex flex-col items-center justify-center gap-3 rounded-2xl border px-4 py-3.5 text-center shadow-lg sm:flex-row sm:justify-between sm:px-5 sm:text-left"
>
  <div class="min-w-0 space-y-1">
    <p class="text-text-muted min-h-5 text-sm">
      {#if titleMissing}
        <span class="text-amber-warn font-medium">{m.form_title_required_hint()}</span>
      {:else}
        {summary}
      {/if}
    </p>
    {#if publish?.blockedReason}
      <p class="text-amber-warn text-sm font-medium" data-testid="publish-blocked-reason">
        {publish.blockedReason}
      </p>
    {/if}
  </div>
  <div class="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row">
    <Button
      variant={publish ? 'secondary' : 'primary'}
      onclick={onSave}
      disabled={isSubmitting || titleMissing || !!publish?.busy}
      class="w-full sm:w-auto"
    >
      <Save size={16} />
      {isSubmitting ? m.form_saving_label() : saveLabel}
    </Button>
    {#if publish}
      <Button
        variant="primary"
        onclick={publish.onPublish}
        disabled={isSubmitting || titleMissing || publish.busy || !!publish.blockedReason}
        title={publish.blockedReason ?? undefined}
        class="w-full sm:w-auto"
      >
        <Send size={16} />
        {publish.busy ? m.form_publishing_label() : m.form_publish_button()}
      </Button>
    {/if}
  </div>
</div>
