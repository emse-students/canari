<script lang="ts">
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import { Log } from '$lib/utils/Log';
  import { listAssociations, type Association } from '$lib/associations/api';
  import { dependentsOf } from '$lib/associations/dependencies';
  import { GitFork } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * WHO DEPENDS ON THIS BDE, read-only on its edit hub (reform F9, WP-D1): a BDE's officers could
   * not see it anywhere. Read from the directory, whose every row carries its governing parent; a
   * platform admin is pointed at `/admin/spaces`, the one place a dependency is changed.
   */
  interface Props {
    asso: Pick<Association, 'id' | 'name'>;
    isGlobalAdmin: boolean;
  }

  let { asso, isGlobalAdmin }: Props = $props();

  let dependents = $state<Association[] | null>(null);
  let failed = $state(false);

  onMount(async () => {
    try {
      dependents = dependentsOf(await listAssociations(), asso.id);
      Log.d(`asso.edit.dependents ${asso.id}: ${dependents.length}`);
    } catch (err) {
      Log.d('asso.edit.dependents failed', err);
      failed = true;
    }
  });
</script>

<section
  class="border-cn-border bg-cn-surface space-y-2 rounded-2xl border p-4"
  data-bde-dependents
>
  <h2 class="text-text-main flex items-center gap-2 text-sm font-bold">
    <GitFork size={16} />
    {m.asso_edit_dependents_title()}
  </h2>
  {#if failed}
    <p class="text-text-muted text-sm">{m.asso_edit_dependents_error()}</p>
  {:else if dependents === null}
    <p class="text-text-muted text-sm">{m.admin_dependencies_loading()}</p>
  {:else if dependents.length === 0}
    <p class="text-text-muted text-sm">{m.asso_edit_dependents_none()}</p>
  {:else}
    <p class="text-text-muted text-xs">
      {m.admin_dependencies_children({ count: dependents.length })}
    </p>
    <ul class="text-text-main flex flex-wrap gap-1.5 text-sm">
      {#each dependents as entity (entity.id)}
        <li
          class="border-cn-border rounded-full border px-2.5 py-0.5"
          class:opacity-60={entity.archived}
        >
          {entity.name}
        </li>
      {/each}
    </ul>
  {/if}
  {#if isGlobalAdmin}
    <a
      href={resolve('/admin/spaces')}
      class="text-cn-dark inline-block text-xs font-semibold underline-offset-2 hover:underline"
    >
      {m.asso_edit_dependents_manage()}
    </a>
  {/if}
</section>
