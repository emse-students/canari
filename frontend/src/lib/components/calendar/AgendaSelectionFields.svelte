<script lang="ts">
  import Picker from '$lib/components/ui/Picker.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { Campus, Formation } from '$lib/profile/miconnectProfile';
  import {
    campusSelectOptions,
    formationSelectOptions,
    hasAgendaSpace,
    isAgendaSelected,
    type AgendaReader,
    type AgendaSelection,
  } from '$lib/calendar/agendaSelection';

  /**
   * The two choices that make an agenda a SELECTION (D40): a campus and a formation, either may stay
   * "any" but not both. Shared by the subscribe modal and the PDF export, which both need one before
   * they can ask the server for anything. ONLY THE READER'S OWN SPACES are offered (user, 2026-10-06):
   * the server signs a subscription link for no other.
   */
  interface Props {
    selection: AgendaSelection;
    /** The reader whose own campus and formations are the only choices; `null` until the profile loads. */
    reader: AgendaReader | null;
    /** Called with the new selection after either choice changes. */
    onChange: (selection: AgendaSelection) => void;
  }

  let { selection, reader, onChange }: Props = $props();

  const campusOptions = $derived(campusSelectOptions(reader));
  const formationOptions = $derived(formationSelectOptions(reader));
  const triggerClass =
    'border-cn-border text-text-main flex w-full items-center justify-between gap-2 rounded-xl border bg-(--cn-surface) px-3 py-2 text-left text-sm font-medium';
</script>

<div class="space-y-2" data-agenda-selection>
  <div class="grid gap-2 sm:grid-cols-2">
    <div class="space-y-1">
      <span class="text-text-muted text-xs font-semibold">{m.calendar_selection_campus()}</span>
      <Picker
        value={selection.campus}
        options={campusOptions}
        label={m.calendar_selection_campus()}
        {triggerClass}
        onValueChange={(v) => onChange({ ...selection, campus: v as Campus | '' })}
      />
    </div>
    <div class="space-y-1">
      <span class="text-text-muted text-xs font-semibold">{m.calendar_selection_formation()}</span>
      <Picker
        value={selection.formation}
        options={formationOptions}
        label={m.calendar_selection_formation()}
        {triggerClass}
        onValueChange={(v) => onChange({ ...selection, formation: v as Formation | '' })}
      />
    </div>
  </div>
  {#if reader && !hasAgendaSpace(reader)}
    <p class="text-text-muted text-xs" role="status" data-agenda-selection-no-space>
      {m.calendar_selection_no_space()}
    </p>
  {:else if !isAgendaSelected(selection)}
    <p class="text-text-muted text-xs" role="status" data-agenda-selection-required>
      {m.calendar_selection_required()}
    </p>
  {/if}
</div>
