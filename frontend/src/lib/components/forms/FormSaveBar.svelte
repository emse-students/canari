<script lang="ts">
  import { Save, Send, Undo2 } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { AutosaveStatus } from '$lib/forms/autosave.svelte';

  /**
   * The sticky-looking footer that says what will be saved and saves it - and, on a DRAFT or a form
   * holding unpublished edits, publishes it (owner, 2026-11-08).
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
    saveLabel?: string;
    /** Called when the save button is pressed; absent where the autosave saves instead. */
    onSave?: (() => void) | null;
    /**
     * The "Publier" action. `blockedReason` shuts it and is shown beside it (a paid form nobody could
     * pay yet, edits not saved); `busy` while it runs; `label` names it ("Publier les modifications").
     */
    publish?: {
      onPublish: () => void;
      blockedReason: string | null;
      busy: boolean;
      label?: string;
    } | null;
    /** "Abandonner les modifications", offered while a published form holds unpublished edits. */
    discard?: { onDiscard: () => void; busy: boolean } | null;
    /** Where the autosave stands, said on its own line. */
    autosaveStatus?: AutosaveStatus | null;
  }

  let {
    titleMissing,
    isSubmitting,
    summary,
    saveLabel = '',
    onSave = null,
    publish = null,
    discard = null,
    autosaveStatus = null,
  }: Props = $props();

  const statusLine = $derived.by(() => {
    switch (autosaveStatus) {
      case 'saving':
        return { text: m.form_autosave_saving(), warn: false };
      case 'saved':
        return { text: m.form_autosave_saved(), warn: false };
      case 'offline':
        return { text: m.form_autosave_offline(), warn: true };
      case 'error':
        return { text: m.form_autosave_error(), warn: true };
      case 'conflict':
        return { text: m.form_autosave_conflict(), warn: true };
      default:
        return null;
    }
  });
  const busy = $derived(isSubmitting || !!publish?.busy || !!discard?.busy);
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
    {#if statusLine}
      <p
        class="text-xs {statusLine.warn ? 'text-amber-warn font-medium' : 'text-text-muted'}"
        data-testid="autosave-status"
        data-status={autosaveStatus}
        role="status"
      >
        {statusLine.text}
      </p>
    {/if}
    {#if publish?.blockedReason}
      <p class="text-amber-warn text-sm font-medium" data-testid="publish-blocked-reason">
        {publish.blockedReason}
      </p>
    {/if}
  </div>
  <div class="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row">
    {#if discard}
      <Button
        variant="ghost"
        onclick={discard.onDiscard}
        disabled={busy}
        class="w-full sm:w-auto"
        data-testid="discard-changes"
      >
        <Undo2 size={16} />
        {m.form_discard_changes_button()}
      </Button>
    {/if}
    {#if onSave}
      <Button
        variant={publish ? 'secondary' : 'primary'}
        onclick={onSave}
        disabled={busy || titleMissing}
        class="w-full sm:w-auto"
      >
        <Save size={16} />
        {isSubmitting ? m.form_saving_label() : saveLabel}
      </Button>
    {/if}
    {#if publish}
      <Button
        variant="primary"
        onclick={publish.onPublish}
        disabled={busy || titleMissing || !!publish.blockedReason}
        title={publish.blockedReason ?? undefined}
        class="w-full sm:w-auto"
        data-testid="publish-button"
      >
        <Send size={16} />
        {publish.busy ? m.form_publishing_label() : (publish.label ?? m.form_publish_button())}
      </Button>
    {/if}
  </div>
</div>
