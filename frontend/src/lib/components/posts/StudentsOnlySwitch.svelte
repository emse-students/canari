<script lang="ts">
  import { untrack } from 'svelte';
  import { ChevronDown } from '@lucide/svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * THE "ENTRE ÉTUDIANTS UNIQUEMENT" SWITCH, as the composer, the reel step and the edit form draw it
   * (owner, 2026-11-16): a plain toggle with no sub-line, tucked in a "more options" disclosure
   * because the full audience is the default and this is the rare case. The disclosure starts
   * collapsed, except when the switch is already ON (a restored draft, an edit of a post that
   * carries it) so a restriction is never hidden. The caller shows it only where it is offered
   * (`studentsOnlyOffered`); OFF is the default.
   */
  interface Props {
    /** Bindable: the post is for students only. */
    checked: boolean;
    /** A save is in flight (the edit form): the switch holds still. */
    busy?: boolean;
  }

  let { checked = $bindable(), busy = false }: Props = $props();

  let expanded = $state(untrack(() => checked));

  $effect(() => {
    Log.d('STUDENTS_ONLY', `switch drawn ${checked ? 'ON' : 'OFF'}`);
  });
</script>

<details
  class="group"
  data-students-only-switch
  open={expanded}
  ontoggle={(e) => (expanded = e.currentTarget.open)}
>
  <summary
    class="text-text-muted flex cursor-pointer list-none items-center gap-1 text-xs font-semibold select-none [&::-webkit-details-marker]:hidden"
  >
    {m.form_card_more_options()}
    <ChevronDown size={14} class="transition-transform group-open:rotate-180" />
  </summary>
  <div class="mt-2">
    <Toggle bind:checked {busy} label={m.post_students_only_label()} />
  </div>
</details>
