<script lang="ts">
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * THE "ENTRE ÉTUDIANTS" SWITCH, as the composer and the edit form draw it (owner, 2026-11-04): one
   * switch with a plain label, and ONE line under it saying who will and will not see the post - the
   * line follows the switch, so the author reads the consequence of the position they chose. The
   * caller shows it only where it is offered (`studentsOnlyOffered`); OFF is the default.
   */
  interface Props {
    /** Bindable: the post is for students only. */
    checked: boolean;
    /** The association or list publishing, named in the explanation. */
    associationName: string;
    /** A save is in flight (the edit form): the switch holds still. */
    busy?: boolean;
  }

  let { checked = $bindable(), associationName, busy = false }: Props = $props();

  $effect(() => {
    Log.d('STUDENTS_ONLY', `switch drawn ${checked ? 'ON' : 'OFF'}`);
  });
</script>

<div data-students-only-switch>
  <Toggle
    bind:checked
    {busy}
    label={m.post_students_only_label()}
    hint={checked
      ? m.post_students_only_hint_on({ name: associationName })
      : m.post_students_only_hint_off({ name: associationName })}
  />
</div>
