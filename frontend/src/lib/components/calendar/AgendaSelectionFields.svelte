<script lang="ts">
  import Picker from '$lib/components/ui/Picker.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { Campus, Formation } from '$lib/profile/miconnectProfile';
  import {
    campusSelectOptions,
    formationSelectOptions,
    isAgendaSelected,
    type AgendaSelection,
  } from '$lib/calendar/agendaSelection';

  /**
   * The two choices that make an agenda a SELECTION (D40): a campus and a formation, either may stay
   * "any" but not both. Shared by the subscribe modal and the PDF export, which both need one before
   * they can ask the server for anything.
   */
  interface Props {
    selection: AgendaSelection;
    /** Called with the new selection after either choice changes. */
    onChange: (selection: AgendaSelection) => void;
  }

  let { selection, onChange }: Props = $props();

  const campusOptions = $derived(campusSelectOptions());
  const formationOptions = $derived(formationSelectOptions());
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
  {#if !isAgendaSelected(selection)}
    <p class="text-text-muted text-xs" role="status" data-agenda-selection-required>
      {m.calendar_selection_required()}
    </p>
  {/if}
</div>
