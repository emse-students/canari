<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { isGlobalAdmin, isAssociationSuperAdmin } from '$lib/stores/user';
  import {
    ensureAssociationSuperAdmin,
    getPosterProject,
    type PosterProject,
  } from '$lib/associations/api';
  import { ArrowLeft, Map } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  let ready = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let project = $state<PosterProject | null>(null);

  const projectId = $derived(page.params.id ?? '');

  onMount(async () => {
    await ensureAssociationSuperAdmin();
    if (!isGlobalAdmin() && !isAssociationSuperAdmin()) {
      void goto('/admin', { replaceState: true });
      return;
    }
    ready = true;
    try {
      project = await getPosterProject(projectId);
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_load_error();
    } finally {
      loading = false;
    }
  });
</script>

{#if ready}
  <div class="space-y-6">
    <a
      href="/admin/carte"
      class="text-sm text-text-muted hover:text-text-main transition-colors inline-flex items-center gap-1"
    >
      <ArrowLeft size={14} />
      {m.carte_editor_back()}
    </a>

    {#if loading}
      <div class="flex justify-center py-16">
        <div
          class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
        ></div>
      </div>
    {:else if error}
      <p class="text-sm text-red-500" role="alert">{error}</p>
    {:else if project}
      <header class="flex items-start gap-3">
        <span
          class="flex h-10 w-10 items-center justify-center rounded-xl bg-cn-yellow/15 text-cn-dark"
        >
          <Map size={20} />
        </span>
        <div>
          <h2 class="text-lg font-extrabold text-text-main">{project.name}</h2>
          <p class="text-sm text-text-muted mt-0.5">{m.carte_editor_coming_soon()}</p>
        </div>
      </header>
    {/if}
  </div>
{/if}
