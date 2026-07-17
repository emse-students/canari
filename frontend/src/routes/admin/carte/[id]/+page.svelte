<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { isGlobalAdmin, isAssociationSuperAdmin } from '$lib/stores/user';
  import {
    ensureAssociationSuperAdmin,
    getPosterProject,
    updatePosterProject,
    listAssociations,
    listAssociationCategories,
    listMembers,
    type PosterProject,
    type AssociationMember,
  } from '$lib/associations/api';
  import { CARTE_THEMES, resolveCarteTheme, DEFAULT_CARTE_THEME_ID } from '$lib/carte/theme';
  import { buildPosterModel, type PosterModel, type PosterLayout } from '$lib/carte/generator';
  import { exportPosterPdf } from '$lib/carte/export';
  import PosterCanvas from '$lib/components/carte/PosterCanvas.svelte';
  import { ArrowLeft, Download, Save, ImagePlus, X, Check } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  let ready = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let project = $state<PosterProject | null>(null);
  let model = $state<PosterModel | null>(null);

  // ── Layout controls (persisted) ──────────────────────────────────────────────
  let themeId = $state(DEFAULT_CARTE_THEME_ID);
  let bgDataUrl = $state<string | null>(null);
  let scrimOpacity = $state(20);

  let saving = $state(false);
  let saved = $state(false);
  let exporting = $state(false);

  const projectId = $derived(page.params.id ?? '');
  const theme = $derived(resolveCarteTheme(themeId));
  const background = $derived({ dataUrl: bgDataUrl, scrimOpacity });

  // ── Scaled preview (poster renders at its natural 1600px width, scaled to fit) ──
  let previewWidth = $state(0);
  let posterEl = $state<HTMLElement>();
  let posterHeight = $state(0);
  const scale = $derived(previewWidth > 0 ? Math.min(1, previewWidth / 1600) : 1);

  // Keep the scaled wrapper's height in sync with the poster's real height.
  $effect(() => {
    const node = posterEl;
    if (!node) return;
    const ro = new ResizeObserver(() => (posterHeight = node.offsetHeight));
    ro.observe(node);
    posterHeight = node.offsetHeight;
    return () => ro.disconnect();
  });

  async function loadData() {
    loading = true;
    error = null;
    try {
      const [proj, categories, associations] = await Promise.all([
        getPosterProject(projectId),
        listAssociationCategories(),
        listAssociations('association'),
      ]);
      project = proj;

      // Hydrate persisted chrome from the opaque layout blob (defensive parse).
      const layout = proj.layout as Partial<PosterLayout>;
      themeId = typeof layout.theme === 'string' ? layout.theme : DEFAULT_CARTE_THEME_ID;
      const bg = layout.background;
      bgDataUrl = bg && typeof bg.dataUrl === 'string' ? bg.dataUrl : null;
      scrimOpacity =
        bg && typeof bg.scrimOpacity === 'number'
          ? bg.scrimOpacity
          : resolveCarteTheme(themeId).scrimOpacity;

      // Resolve rosters (for president detection); tolerate per-asso failures.
      const rosters = await Promise.all(
        associations.map((a) => listMembers(a.id).catch(() => [] as AssociationMember[]))
      );
      const membersByAsso: Record<string, AssociationMember[]> = {};
      associations.forEach((a, i) => (membersByAsso[a.id] = rosters[i]));

      model = buildPosterModel(
        associations,
        categories,
        membersByAsso,
        m.carte_zone_uncategorized()
      );
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_load_error();
    } finally {
      loading = false;
    }
  }

  function onBackgroundFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      bgDataUrl = typeof reader.result === 'string' ? reader.result : null;
    };
    reader.readAsDataURL(file);
  }

  async function handleSave() {
    if (!project || saving) return;
    saving = true;
    saved = false;
    error = null;
    try {
      const layout: PosterLayout = {
        version: 1,
        theme: themeId,
        background: { dataUrl: bgDataUrl, scrimOpacity },
      };
      project = await updatePosterProject(project.id, {
        layout: layout as unknown as Record<string, unknown>,
      });
      saved = true;
      setTimeout(() => (saved = false), 2500);
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_save_error();
    } finally {
      saving = false;
    }
  }

  async function handleExport() {
    if (!posterEl || !project || exporting) return;
    exporting = true;
    error = null;
    try {
      await exportPosterPdf(posterEl, project.name);
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_generic_error_label();
    } finally {
      exporting = false;
    }
  }

  onMount(async () => {
    await ensureAssociationSuperAdmin();
    if (!isGlobalAdmin() && !isAssociationSuperAdmin()) {
      void goto('/admin', { replaceState: true });
      return;
    }
    ready = true;
    void loadData();
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
    {:else if error && !project}
      <p class="text-sm text-red-500" role="alert">{error}</p>
    {:else if project && model}
      <header class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-lg font-extrabold text-text-main">{project.name}</h2>
        <div class="flex items-center gap-2">
          <button
            type="button"
            onclick={handleSave}
            disabled={saving}
            class="inline-flex items-center gap-2 rounded-xl border border-cn-border px-4 py-2 text-sm font-bold text-text-main hover:bg-cn-bg disabled:opacity-50"
          >
            {#if saved}
              <Check size={16} />
              {m.carte_saved_label()}
            {:else}
              <Save size={16} />
              {saving ? m.carte_saving_label() : m.carte_save_button()}
            {/if}
          </button>
          <button
            type="button"
            onclick={handleExport}
            disabled={exporting}
            class="inline-flex items-center gap-2 rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
          >
            <Download size={16} />
            {exporting ? m.carte_exporting_label() : m.carte_export_button()}
          </button>
        </div>
      </header>

      {#if error}
        <p class="text-sm text-red-500" role="alert">{error}</p>
      {/if}

      <!-- Settings -->
      <section class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-4 space-y-4">
        <h3 class="text-sm font-bold text-text-main">{m.carte_settings_heading()}</h3>

        <div class="space-y-2">
          <span class="block text-xs font-semibold text-text-muted">{m.carte_theme_label()}</span>
          <div class="flex flex-wrap gap-2">
            {#each CARTE_THEMES as t (t.id)}
              <button
                type="button"
                onclick={() => (themeId = t.id)}
                class="rounded-xl border px-3 py-1.5 text-sm font-semibold transition-colors
                {themeId === t.id
                  ? 'border-cn-yellow bg-cn-yellow/15 text-cn-dark'
                  : 'border-cn-border text-text-muted hover:text-text-main'}"
              >
                {t.name()}
              </button>
            {/each}
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <span class="block text-xs font-semibold text-text-muted"
            >{m.carte_background_label()}</span
          >
          <label
            class="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-cn-border px-3 py-1.5 text-sm font-semibold text-text-main hover:bg-cn-bg"
          >
            <ImagePlus size={15} />
            {m.carte_background_upload()}
            <input type="file" accept="image/*" class="hidden" onchange={onBackgroundFile} />
          </label>
          {#if bgDataUrl}
            <button
              type="button"
              onclick={() => (bgDataUrl = null)}
              class="inline-flex items-center gap-1.5 rounded-xl border border-cn-border px-3 py-1.5 text-sm font-semibold text-text-muted hover:text-text-main"
            >
              <X size={15} />
              {m.carte_background_clear()}
            </button>
            <label class="inline-flex items-center gap-2 text-xs text-text-muted">
              {m.carte_scrim_label()}
              <input
                type="range"
                min="0"
                max="80"
                bind:value={scrimOpacity}
                class="accent-cn-yellow"
              />
            </label>
          {/if}
        </div>

        <p class="text-xs text-text-muted">{m.carte_generated_note()}</p>
      </section>

      <!-- Scaled poster preview (the node captured for PDF is the un-scaled inner element). -->
      <div
        bind:clientWidth={previewWidth}
        class="overflow-hidden rounded-2xl border border-cn-border"
        style:height="{posterHeight * scale}px"
      >
        <div style:transform="scale({scale})" style:transform-origin="top left">
          <PosterCanvas bind:el={posterEl} {model} {theme} {background} title={project.name} />
        </div>
      </div>
    {/if}
  </div>
{/if}
