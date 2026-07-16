<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { isGlobalAdmin, isAssociationSuperAdmin } from '$lib/stores/user';
  import {
    ensureAssociationSuperAdmin,
    listAssociationCategories,
    createAssociationCategory,
    updateAssociationCategory,
    deleteAssociationCategory,
    reorderAssociationCategories,
    listPosterProjects,
    createPosterProject,
    deletePosterProject,
    type AssociationCategory,
    type PosterProject,
  } from '$lib/associations/api';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { Map, Plus, Trash2, ChevronUp, ChevronDown, Pencil } from '@lucide/svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { m } from '$lib/paraglide/messages';

  let ready = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // ── Categories ──────────────────────────────────────────────────────────────
  let categories = $state<AssociationCategory[]>([]);
  let newCategoryLabel = $state('');
  let addingCategory = $state(false);
  const busyCategoryIds = new SvelteSet<string>();

  // ── Poster projects ─────────────────────────────────────────────────────────
  let projects = $state<PosterProject[]>([]);
  let newProjectName = $state('');
  let creatingProject = $state(false);
  const busyProjectIds = new SvelteSet<string>();

  /** Derives a URL-safe slug from a free-text label (accent-stripped, hyphenated). */
  function slugify(label: string): string {
    return label
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  async function load() {
    loading = true;
    error = null;
    try {
      [categories, projects] = await Promise.all([
        listAssociationCategories(),
        listPosterProjects(),
      ]);
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_load_error();
    } finally {
      loading = false;
    }
  }

  async function handleAddCategory() {
    const label = newCategoryLabel.trim();
    const slug = slugify(label);
    if (!label || !slug || addingCategory) return;
    addingCategory = true;
    error = null;
    try {
      const created = await createAssociationCategory({
        label,
        slug,
        sortOrder: categories.length,
      });
      categories = [...categories, created];
      newCategoryLabel = '';
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_generic_error_label();
    } finally {
      addingCategory = false;
    }
  }

  async function handleRenameCategory(cat: AssociationCategory, label: string) {
    const trimmed = label.trim();
    if (!trimmed || trimmed === cat.label || busyCategoryIds.has(cat.id)) return;
    busyCategoryIds.add(cat.id);
    error = null;
    try {
      const updated = await updateAssociationCategory(cat.id, { label: trimmed });
      categories = categories.map((c) => (c.id === cat.id ? updated : c));
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_save_error();
    } finally {
      busyCategoryIds.delete(cat.id);
    }
  }

  async function handleDeleteCategory(cat: AssociationCategory) {
    if (
      !(await showConfirm(m.carte_category_delete_confirm({ label: cat.label }), {
        danger: true,
        confirmLabel: m.common_remove_label(),
      }))
    )
      return;
    busyCategoryIds.add(cat.id);
    error = null;
    try {
      await deleteAssociationCategory(cat.id);
      categories = categories.filter((c) => c.id !== cat.id);
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_delete_error();
    } finally {
      busyCategoryIds.delete(cat.id);
    }
  }

  /** Moves a category up (-1) or down (+1) and persists the new order. */
  async function handleMoveCategory(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= categories.length) return;
    const reordered = [...categories];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    categories = reordered;
    error = null;
    try {
      categories = await reorderAssociationCategories(reordered.map((c) => c.id));
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_save_error();
      void load();
    }
  }

  async function handleCreateProject() {
    const name = newProjectName.trim();
    if (!name || creatingProject) return;
    creatingProject = true;
    error = null;
    try {
      const created = await createPosterProject({ name });
      projects = [created, ...projects];
      newProjectName = '';
      void goto(`/admin/carte/${created.id}`);
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_generic_error_label();
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
      error = e instanceof Error ? e.message : m.common_delete_error();
    } finally {
      busyProjectIds.delete(project.id);
    }
  }

  onMount(async () => {
    await ensureAssociationSuperAdmin();
    if (!isGlobalAdmin() && !isAssociationSuperAdmin()) {
      void goto('/admin', { replaceState: true });
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
        class="flex h-10 w-10 items-center justify-center rounded-xl bg-cn-yellow/15 text-cn-dark"
      >
        <Map size={20} />
      </span>
      <div>
        <h2 class="text-lg font-extrabold text-text-main">{m.carte_title()}</h2>
        <p class="text-sm text-text-muted mt-0.5">{m.carte_subtitle()}</p>
      </div>
    </header>

    {#if error}
      <p class="text-sm text-red-500" role="alert">{error}</p>
    {/if}

    {#if loading}
      <div class="flex justify-center py-16">
        <div
          class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
        ></div>
      </div>
    {:else}
      <!-- Categories -->
      <section class="space-y-3">
        <div>
          <h3 class="text-base font-bold text-text-main">{m.carte_categories_heading()}</h3>
          <p class="text-sm text-text-muted">{m.carte_categories_subtitle()}</p>
        </div>

        <form
          class="flex flex-col gap-2 sm:flex-row"
          onsubmit={(e) => {
            e.preventDefault();
            void handleAddCategory();
          }}
        >
          <input
            bind:value={newCategoryLabel}
            placeholder={m.carte_category_label_placeholder()}
            class="flex-1 min-w-0 rounded-xl border border-cn-border bg-cn-bg/30 px-4 py-2.5 text-sm text-text-main"
          />
          <button
            type="submit"
            disabled={addingCategory || !newCategoryLabel.trim()}
            class="inline-flex items-center justify-center gap-2 rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
          >
            <Plus size={16} />
            {addingCategory ? m.common_saving_label() : m.carte_category_add_button()}
          </button>
        </form>

        <div
          class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] divide-y divide-cn-border/70 overflow-hidden"
        >
          {#if categories.length === 0}
            <p class="px-4 py-8 text-center text-sm text-text-muted">
              {m.carte_categories_empty()}
            </p>
          {:else}
            {#each categories as cat, index (cat.id)}
              <div class="flex items-center gap-2 px-3 py-2.5">
                <div class="flex flex-col">
                  <button
                    type="button"
                    onclick={() => void handleMoveCategory(index, -1)}
                    disabled={index === 0 || busyCategoryIds.has(cat.id)}
                    title={m.carte_category_move_up()}
                    class="text-text-muted hover:text-text-main disabled:opacity-30"
                  >
                    <ChevronUp size={16} />
                  </button>
                  <button
                    type="button"
                    onclick={() => void handleMoveCategory(index, 1)}
                    disabled={index === categories.length - 1 || busyCategoryIds.has(cat.id)}
                    title={m.carte_category_move_down()}
                    class="text-text-muted hover:text-text-main disabled:opacity-30"
                  >
                    <ChevronDown size={16} />
                  </button>
                </div>
                <input
                  value={cat.label}
                  onblur={(e) => void handleRenameCategory(cat, e.currentTarget.value)}
                  disabled={busyCategoryIds.has(cat.id)}
                  class="flex-1 min-w-0 rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-sm font-semibold text-text-main hover:border-cn-border focus:border-cn-border focus:bg-cn-bg/30 focus:outline-none"
                />
                <span class="hidden shrink-0 text-xs text-text-muted sm:inline">{cat.slug}</span>
                <button
                  type="button"
                  onclick={() => handleDeleteCategory(cat)}
                  disabled={busyCategoryIds.has(cat.id)}
                  title={m.common_remove_label()}
                  class="inline-flex items-center justify-center rounded-lg border border-red-200 bg-red-50/80 p-1.5 text-red-600 hover:bg-red-100 disabled:opacity-50 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            {/each}
          {/if}
        </div>
      </section>

      <!-- Poster projects -->
      <section class="space-y-3">
        <div>
          <h3 class="text-base font-bold text-text-main">{m.carte_projects_heading()}</h3>
          <p class="text-sm text-text-muted">{m.carte_projects_subtitle()}</p>
        </div>

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
            class="flex-1 min-w-0 rounded-xl border border-cn-border bg-cn-bg/30 px-4 py-2.5 text-sm text-text-main"
          />
          <button
            type="submit"
            disabled={creatingProject || !newProjectName.trim()}
            class="inline-flex items-center justify-center gap-2 rounded-xl bg-cn-yellow px-5 py-2.5 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
          >
            <Plus size={16} />
            {creatingProject ? m.common_saving_label() : m.carte_project_create_button()}
          </button>
        </form>

        <div
          class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] divide-y divide-cn-border/70 overflow-hidden"
        >
          {#if projects.length === 0}
            <p class="px-4 py-8 text-center text-sm text-text-muted">{m.carte_projects_empty()}</p>
          {:else}
            {#each projects as project (project.id)}
              <div class="flex items-center justify-between gap-3 px-4 py-3">
                <div class="min-w-0">
                  <span class="block truncate text-sm font-semibold text-text-main">
                    {project.name}
                  </span>
                  <span class="block truncate text-xs text-text-muted">
                    {m.carte_project_updated_at({
                      date: new Date(project.updatedAt).toLocaleDateString(),
                    })}
                  </span>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <a
                    href={`/admin/carte/${project.id}`}
                    class="inline-flex items-center gap-1.5 rounded-xl border border-cn-border px-3 py-2 text-sm font-semibold text-text-main hover:bg-cn-bg"
                  >
                    <Pencil size={14} />
                    {m.carte_project_open()}
                  </a>
                  <button
                    type="button"
                    onclick={() => handleDeleteProject(project)}
                    disabled={busyProjectIds.has(project.id)}
                    title={m.common_remove_label()}
                    class="inline-flex items-center justify-center rounded-xl border border-red-200 bg-red-50/80 p-2 text-red-600 hover:bg-red-100 disabled:opacity-50 transition-colors"
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
