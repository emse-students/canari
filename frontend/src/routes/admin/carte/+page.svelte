<script lang="ts">
  import { resolve } from '$app/paths';
  import { Log } from '$lib/utils/Log';
  import { onMount } from 'svelte';
  import { isCoarsePointerDevice, onCoarsePointerChange } from '$lib/utils/pointerDevice';
  import { goto } from '$app/navigation';
  import { isGlobalAdmin, isAssociationSuperAdmin } from '$lib/stores/user';
  import {
    ensureAssociationSuperAdmin,
    listPosterProjects,
    listCarteSpaces,
    createPosterProject,
    deletePosterProject,
    type CarteSpace,
    type PosterProject,
  } from '$lib/associations/api';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { Map, Plus, Trash2, Pencil, Globe } from '@lucide/svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { m } from '$lib/paraglide/messages';
  import Button from '$lib/components/ui/Button.svelte';
  import Picker from '$lib/components/ui/Picker.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
  import { carteSpaceLabel } from '$lib/carte/spaceLabel';

  let ready = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // ── Poster projects: each map belongs to ONE space (owner, 2026-11-08) ──────
  let projects = $state<PosterProject[]>([]);
  /** The spaces the caller may draw maps for: its BDE's, or every one for the platform admin. */
  let spaces = $state<CarteSpace[]>([]);
  let newProjectName = $state('');
  let newProjectSpaceId = $state('');
  let creatingProject = $state(false);
  const busyProjectIds = new SvelteSet<string>();

  const spaceOptions = $derived<PickerOption[]>(
    spaces.map((s) => ({ value: s.id, label: carteSpaceLabel(s) }))
  );
  /** A map's space as words; a map listed here is one the server let the caller see. */
  const spaceName = (id: string | null): string => {
    const space = id ? spaces.find((s) => s.id === id) : undefined;
    return space ? carteSpaceLabel(space) : m.carte_space_none();
  };

  async function load() {
    loading = true;
    error = null;
    try {
      [projects, spaces] = await Promise.all([listPosterProjects(), listCarteSpaces()]);
      // One space in charge is the usual case: nothing to choose.
      if (spaces.length === 1) newProjectSpaceId = spaces[0].id;
      Log.d('admin.carte.load', { projects: projects.length, spaces: spaces.length });
    } catch (e) {
      Log.d('admin.carte.load failed', e);
      error = m.common_load_error();
    } finally {
      loading = false;
    }
  }

  async function handleCreateProject() {
    const name = newProjectName.trim();
    if (!name || !newProjectSpaceId || creatingProject) return;
    creatingProject = true;
    error = null;
    try {
      const created = await createPosterProject({ name, spaceId: newProjectSpaceId });
      projects = [created, ...projects];
      newProjectName = '';
      void goto(resolve(`admin/carte/${created.id}`));
    } catch (e) {
      Log.d('admin.carte.handleCreateProject failed', e);
      error = m.common_generic_error_label();
    } finally {
      creatingProject = false;
    }
  }

  async function handleDeleteProject(project: PosterProject) {
    if (
      !(await showConfirm(m.carte_project_delete_confirm({ name: project.name }), {
        danger: true,
        confirmLabel: m.common_remove_label(),
      }))
    )
      return;
    busyProjectIds.add(project.id);
    error = null;
    try {
      await deletePosterProject(project.id);
      projects = projects.filter((p) => p.id !== project.id);
    } catch (e) {
      Log.d('admin.carte.handleDeleteProject failed', e);
      error = m.common_delete_error();
    } finally {
      busyProjectIds.delete(project.id);
    }
  }

  // Same predicate as the editor: what decides is the pointer, not the width.
  let coarsePointer = $state(false);
  $effect(() => {
    coarsePointer = isCoarsePointerDevice();
    return onCoarsePointerChange((coarse) => (coarsePointer = coarse));
  });

  onMount(async () => {
    await ensureAssociationSuperAdmin();
    if (!isGlobalAdmin() && !isAssociationSuperAdmin()) {
      void goto(resolve('/admin'), { replace: true });
      return;
    }
    ready = true;
    void load();
  });
</script>

{#if ready}
  <div class="space-y-8">
    <header class="flex items-start gap-3">
      <span
        class="bg-cn-yellow/15 text-cn-dark flex h-10 w-10 items-center justify-center rounded-xl"
      >
        <Map size={20} />
      </span>
      <div>
        <h2 class="text-text-main text-lg font-bold">{m.carte_title()}</h2>
        <p class="text-text-muted mt-0.5 text-sm">{m.carte_subtitle()}</p>
      </div>
    </header>

    {#if error}
      <p class="text-sm text-red-500" role="alert">{error}</p>
    {/if}

    {#if loading}
      <div class="flex justify-center py-16">
        <div
          class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
        ></div>
      </div>
    {:else}
      <!-- Poster projects -->
      <section class="space-y-3">
        <div>
          <h3 class="text-text-main text-base font-bold">{m.carte_projects_heading()}</h3>
          <p class="text-text-muted text-sm">{m.carte_projects_subtitle()}</p>
        </div>

        <!-- Creating a map leads straight into an editor a finger cannot use, so the form is
             absent there rather than offering a dead end. -->
        {#if coarsePointer}
          <p class="text-text-muted text-sm">{m.carte_desktop_only_short()}</p>
        {:else}
          {#if spaces.length === 0}
            <p class="text-text-muted text-sm">{m.carte_spaces_none()}</p>
          {:else}
            <form
              class="flex flex-col gap-2 sm:flex-row"
              onsubmit={(e) => {
                e.preventDefault();
                void handleCreateProject();
              }}
            >
              <input
                bind:value={newProjectName}
                placeholder={m.carte_project_name_placeholder()}
                class="border-cn-border bg-cn-bg/30 text-text-main min-w-0 flex-1 rounded-xl border px-4 py-2.5 text-sm"
              />
              {#if spaces.length > 1}
                <Picker
                  value={newProjectSpaceId}
                  options={spaceOptions}
                  onValueChange={(v) => (newProjectSpaceId = v)}
                  label={m.carte_space_pick()}
                  placeholder={m.carte_space_pick()}
                  variant="field"
                />
              {/if}
              <Button
                type="submit"
                disabled={creatingProject || !newProjectName.trim() || !newProjectSpaceId}
              >
                <Plus size={16} />
                {creatingProject ? m.common_saving_label() : m.carte_project_create_button()}
              </Button>
            </form>
          {/if}
        {/if}

        <div
          class="border-cn-border divide-cn-border/70 divide-y overflow-hidden rounded-2xl border bg-(--cn-surface)"
        >
          {#if projects.length === 0}
            <p class="text-text-muted px-4 py-8 text-center text-sm">{m.carte_projects_empty()}</p>
          {:else}
            {#each projects as project (project.id)}
              <div class="flex items-center justify-between gap-3 px-4 py-3">
                <div class="min-w-0">
                  <span class="text-text-main block truncate text-sm font-semibold">
                    {project.name}
                  </span>
                  <span class="text-text-muted flex items-center gap-1.5 truncate text-xs">
                    {#if project.publishedAt}
                      <Globe size={12} class="text-green-600 dark:text-green-400" />
                    {/if}
                    {spaceName(project.spaceId)} -
                    {m.carte_project_updated_at({
                      date: new Date(project.updatedAt).toLocaleDateString(),
                    })}
                  </span>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <a
                    href={resolve(`admin/carte/${project.id}`)}
                    class="border-cn-border text-text-main hover:bg-cn-bg inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-semibold"
                  >
                    <Pencil size={14} />
                    {m.carte_project_open()}
                  </a>
                  <button
                    type="button"
                    onclick={() => handleDeleteProject(project)}
                    disabled={busyProjectIds.has(project.id)}
                    title={m.common_remove_label()}
                    class="ui-icon-button border-red-err/30 bg-red-err/10 text-red-err hover:bg-red-err/20 rounded-xl border transition-colors disabled:opacity-50"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            {/each}
          {/if}
        </div>
      </section>
    {/if}
  </div>
{/if}
