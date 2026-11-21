<script lang="ts">
  /**
   * THE QUESTION PUT TO A FORM LEFT OPEN (owner, 2026-11-21): "Ce formulaire est toujours ouvert. Le
   * fermer ?" with its three answers - close it, keep it open, set a closing date. It is drawn on the
   * managers' list while the server says the question is still put (`Form.staleOpenAsk`) and is the
   * landing of the bell row (`/forms?responses=<id>`), so a notice and its answer are one page.
   *
   * The three answers are the parent's: "Fermer" is the list's own close (with its confirmation),
   * the other two are the server's `keep-open` and `closing-date` routes. The date field offers the
   * suggestion of the form's nature (`closingSuggestion.ts`) so "Fixer une date" is one more tap.
   */
  import { CalendarClock } from '@lucide/svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import DateTimeField from '$lib/components/ui/DateTimeField.svelte';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The date the field starts on (`datetime-local`), the suggestion for this form. */
    suggestedDate: string;
    /** The earliest date allowed (`datetime-local`): now, as the parent reads it. */
    minDate: string;
    busy: boolean;
    onClose: () => void;
    onKeepOpen: () => void;
    /** Called with the chosen `datetime-local` value. */
    onSetDate: (value: string) => void;
  }

  let { suggestedDate, minDate, busy, onClose, onKeepOpen, onSetDate }: Props = $props();

  /** Whether the date field is shown (after "Fixer une date"). */
  let picking = $state(false);
  // Shows the suggestion until the manager edits their own value.
  let chosen = $state<string | null>(null);
  const value = $derived(chosen ?? suggestedDate);
</script>

<div
  class="border-cn-border bg-accent/10 space-y-2 border-t-2 px-4 py-3 @md:px-5"
  data-testid="form-stale-open-card"
>
  <p class="text-text-main flex items-center gap-1.5 text-sm font-semibold">
    <CalendarClock size={15} />
    {m.form_stale_open_title()}
  </p>
  <p class="text-text-muted text-xs">{m.form_stale_open_hint()}</p>
  <div class="flex flex-wrap items-center gap-2">
    <Button
      size="compact"
      variant="secondary"
      onclick={onClose}
      disabled={busy}
      data-testid="form-stale-open-close"
    >
      {m.form_stale_open_close()}
    </Button>
    <Button
      size="compact"
      variant="secondary"
      onclick={onKeepOpen}
      disabled={busy}
      data-testid="form-stale-open-keep"
    >
      {m.form_stale_open_keep()}
    </Button>
    {#if !picking}
      <Button
        size="compact"
        variant="secondary"
        onclick={() => (picking = true)}
        disabled={busy}
        data-testid="form-stale-open-date"
      >
        {m.form_stale_open_date()}
      </Button>
    {/if}
  </div>
  {#if picking}
    <div class="flex flex-wrap items-center gap-2" data-testid="form-stale-open-picker">
      <DateTimeField
        {value}
        onValueChange={(v) => (chosen = v)}
        label={m.form_stale_open_date_label()}
        min={minDate}
        density="default"
      />
      <Button
        size="compact"
        variant="primary"
        onclick={() => onSetDate(value)}
        disabled={busy || !value}
        data-testid="form-stale-open-date-confirm"
      >
        {m.form_stale_open_date_confirm()}
      </Button>
    </div>
  {/if}
</div>
