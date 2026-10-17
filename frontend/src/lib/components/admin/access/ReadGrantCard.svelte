<script lang="ts">
  /**
   * ONE NAMED READER: their name, what they read as chips grouped by campus, and "Edit".
   *
   * It replaces a row of a person x 12-checkbox table that no phone could show without scrolling
   * sideways (user, 2026-10-16). The cells are edited in `ReadGrantSheet`; this card only reads.
   */
  import { Pencil } from '@lucide/svelte';
  import type { ReadGrant } from '$lib/associations/api';
  import { groupGrantsByCampus } from '$lib/admin/readAccess';
  import { campusLabel, formationLabel } from '$lib/profile/miconnectProfile';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    name: string;
    /** This person's grants only. */
    grants: ReadGrant[];
    onEdit: () => void;
  }

  let { name, grants, onEdit }: Props = $props();

  const groups = $derived(groupGrantsByCampus(grants));
</script>

<li
  class="border-cn-border bg-cn-surface flex items-start gap-3 rounded-lg border px-4 py-3"
  data-testid="read-grant-card"
>
  <div class="min-w-0 flex-1 space-y-2">
    <p class="text-text-main truncate text-sm font-semibold">{name}</p>
    {#if groups.length === 0}
      <p class="text-text-muted text-sm">{m.readaccess_no_access()}</p>
    {:else}
      <dl class="space-y-1.5">
        {#each groups as group (group.campus)}
          <div class="flex flex-wrap items-center gap-1.5">
            <dt class="text-text-muted mr-1 text-xs font-semibold">{campusLabel(group.campus)}</dt>
            {#each group.scopes as scope (scope ?? '*')}
              <dd
                class="bg-cn-surface-alt text-text-main rounded-full px-2.5 py-0.5 text-xs font-medium"
                data-testid="read-grant-chip"
              >
                {scope === null ? m.readaccess_whole_campus() : formationLabel(scope)}
              </dd>
            {/each}
          </div>
        {/each}
      </dl>
    {/if}
  </div>
  <button
    type="button"
    onclick={onEdit}
    aria-label={m.readaccess_edit_aria({ name })}
    class="border-cn-border text-text-main hover:bg-cn-surface-alt inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors"
  >
    <Pencil size={14} />
    {m.common_edit_label()}
  </button>
</li>
