<script lang="ts">
  import Select from '$lib/components/ui/Select.svelte';
  import { CONTROL_HINT_CLASS } from '$lib/components/ui/controlClasses';
  import { m } from '$lib/paraglide/messages';

  /**
   * The association a DRAFT form belongs to, chosen by its builder - the create page and the editor
   * of a draft alike (owner, 2026-11-09: the autosave must not lock it).
   *
   * The choice rides in the autosaved revision like every other field and is applied when the form
   * is published; the server lets a draft move only when its actor is a member of the association it
   * leaves and of the one it joins. A PUBLISHED form's association is not offered here: its editor
   * shows it read-only and says why (`form_association_locked_hint`).
   */
  interface Props {
    /** The associations offered: the builder's memberships, plus the draft's own if it is not one. */
    associations: { id: string; name: string }[];
    /** The chosen association's id, `''` for a personal form. */
    value: string;
    /** Whether the choice differs from the association the server holds the draft under. */
    pendingMove?: boolean;
    onValueChange: (value: string) => void;
  }

  let { associations, value, pendingMove = false, onValueChange }: Props = $props();
</script>

<div>
  <Select
    id="association-select"
    label={m.form_association_label()}
    hint={m.form_association_hint()}
    {value}
    options={[
      { value: '', label: m.form_association_none() },
      ...associations.map((a) => ({ value: a.id, label: a.name })),
    ]}
    {onValueChange}
  />
  {#if pendingMove}
    <p class={CONTROL_HINT_CLASS} data-testid="form-association-pending">
      {m.form_association_applies_at_publish()}
    </p>
  {/if}
</div>
