<script lang="ts">
  import { onMount, tick } from 'svelte';
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
  import { CARTE_STYLE, DEFAULT_SCRIM_OPACITY } from '$lib/carte/theme';
  import { buildPosterModel, type PosterModel, type PosterLayout } from '$lib/carte/generator';
  import {
    mergeBubbleLayout,
    seedBubbleLayout,
    indexBubbleContent,
    stageHeight,
    createTextDecoration,
    sanitizeDecorations,
    TEXT_BASE_WIDTH,
    type PositionedBubble,
    type Decoration,
  } from '$lib/carte/layout';
  import { exportPosterPdf } from '$lib/carte/export';
  import PosterCanvas from '$lib/components/carte/PosterCanvas.svelte';
  import {
    ArrowLeft,
    Download,
    Save,
    ImagePlus,
    X,
    Check,
    BringToFront,
    SendToBack,
    RotateCcw,
    Type,
    Trash2,
    AlignLeft,
    AlignCenter,
    AlignRight,
    Maximize,
    Minimize,
  } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';

  let ready = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let project = $state<PosterProject | null>(null);
  let model = $state<PosterModel | null>(null);

  // ── Layout controls (persisted) ──────────────────────────────────────────────
  let bgDataUrl = $state<string | null>(null);
  let scrimOpacity = $state(DEFAULT_SCRIM_OPACITY);
  let directoryVisible = $state(true);
  // Single fixed poster style (the theme picker was dropped); the bg image, if any, replaces it.
  const theme = CARTE_STYLE;

  // ── Freeform bubble placement (persisted as layout.bubbles) ───────────────────
  let positioned = $state<PositionedBubble[]>([]);
  let selectedId = $state<string | null>(null);

  // ── Free-form decorations (persisted as layout.decorations) ───────────────────
  let decorations = $state<Decoration[]>([]);
  let selectedDecorationId = $state<string | null>(null);

  let saving = $state(false);
  let saved = $state(false);
  let exporting = $state(false);

  // ── Full-page editing ─────────────────────────────────────────────────────────
  // An in-app overlay (fixed inset-0) that fills the browser window while keeping its chrome - NOT
  // the Fullscreen API, which hides the whole browser interface.
  let isFullPage = $state(false);

  /** Toggles the in-app full-page overlay so authoring can use the whole window. */
  function toggleFullPage() {
    isFullPage = !isFullPage;
  }

  const projectId = $derived(page.params.id ?? '');
  const background = $derived({ dataUrl: bgDataUrl, scrimOpacity });
  const content = $derived(model ? indexBubbleContent(model) : {});
  const canvasHeight = $derived(stageHeight(positioned, decorations));
  const selectedBubble = $derived(positioned.find((b) => b.assoId === selectedId) ?? null);
  const selectedContent = $derived(selectedId ? content[selectedId] : undefined);
  const selectedDecoration = $derived(
    decorations.find((d) => d.id === selectedDecorationId) ?? null
  );
  /** The selected decoration narrowed to a text box, or null (drives the text-only controls). */
  const selectedTextDeco = $derived(
    selectedDecoration?.kind === 'text' ? selectedDecoration : null
  );

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
      const bg = layout.background;
      bgDataUrl = bg && typeof bg.dataUrl === 'string' ? bg.dataUrl : null;
      scrimOpacity =
        bg && typeof bg.scrimOpacity === 'number' ? bg.scrimOpacity : DEFAULT_SCRIM_OPACITY;
      directoryVisible = layout.directoryVisible !== false;
      decorations = sanitizeDecorations(layout.decorations);

      // Resolve rosters (for president detection); tolerate per-asso failures.
      const rosters = await Promise.all(
        associations.map((a) => listMembers(a.id).catch(() => [] as AssociationMember[]))
      );
      const membersByAsso: Record<string, AssociationMember[]> = {};
      associations.forEach((a, i) => (membersByAsso[a.id] = rosters[i]));

      const built = buildPosterModel(
        associations,
        categories,
        membersByAsso,
        m.carte_zone_uncategorized()
      );
      model = built;

      // Reconcile saved positions with the live model (adds new assos, drops removed ones).
      const savedBubbles = Array.isArray(layout.bubbles)
        ? (layout.bubbles as PositionedBubble[])
        : [];
      positioned = mergeBubbleLayout(savedBubbles, built);
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_load_error();
    } finally {
      loading = false;
    }
  }

  // ── Bubble mutations ──────────────────────────────────────────────────────────
  function patchBubble(id: string, patch: Partial<PositionedBubble>) {
    positioned = positioned.map((b) => (b.assoId === id ? { ...b, ...patch } : b));
  }
  function bringToFront(id: string) {
    const max = positioned.reduce((acc, b) => Math.max(acc, b.z), 0);
    patchBubble(id, { z: max + 1 });
  }
  function sendToBack(id: string) {
    const min = positioned.reduce((acc, b) => Math.min(acc, b.z), 0);
    patchBubble(id, { z: min - 1 });
  }
  function resetBubble(id: string) {
    if (!model) return;
    const seed = seedBubbleLayout(model).find((b) => b.assoId === id);
    if (seed) patchBubble(id, { x: seed.x, y: seed.y, scale: 1 });
  }

  // ── Decoration mutations ────────────────────────────────────────────────────────
  function patchDecoration(id: string, patch: Partial<Decoration>) {
    // The spread keeps d's own kind; cast reassures TS the union member stays intact.
    decorations = decorations.map((d) => (d.id === id ? ({ ...d, ...patch } as Decoration) : d));
  }
  /** Adds a new text box near the top-center of the stage and selects it. */
  function addText() {
    const z = decorations.reduce((acc, d) => Math.max(acc, d.z), 0) + 1;
    const deco = createTextDecoration((1600 - TEXT_BASE_WIDTH) / 2, 140, z, theme.titleColor);
    decorations = [...decorations, deco];
    selectedId = null;
    selectedDecorationId = deco.id;
  }
  function deleteDecoration(id: string) {
    decorations = decorations.filter((d) => d.id !== id);
    if (selectedDecorationId === id) selectedDecorationId = null;
  }
  function decoBringToFront(id: string) {
    const max = decorations.reduce((acc, d) => Math.max(acc, d.z), 0);
    patchDecoration(id, { z: max + 1 });
  }
  function decoSendToBack(id: string) {
    const min = decorations.reduce((acc, d) => Math.min(acc, d.z), 0);
    patchDecoration(id, { z: min - 1 });
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
        background: { dataUrl: bgDataUrl, scrimOpacity },
        bubbles: positioned,
        directoryVisible,
        decorations,
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
    // Clear selections so no outline + resize handles are captured in the PDF.
    selectedId = null;
    selectedDecorationId = null;
    await tick();
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
            onclick={toggleFullPage}
            class="inline-flex items-center gap-2 rounded-xl border border-cn-border px-4 py-2 text-sm font-bold text-text-main hover:bg-cn-bg"
          >
            {#if isFullPage}
              <Minimize size={16} />
            {:else}
              <Maximize size={16} />
            {/if}
            {isFullPage ? m.carte_fullpage_exit() : m.carte_fullpage_enter()}
          </button>
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

      <div
        class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px] {isFullPage
          ? 'fixed inset-0 z-50 overflow-auto bg-cn-bg p-5'
          : ''}"
      >
        <!-- Scaled poster preview (the node captured for PDF is the un-scaled inner element). -->
        <div
          bind:clientWidth={previewWidth}
          class="overflow-hidden rounded-2xl border border-cn-border"
          style:height="{posterHeight * scale}px"
        >
          <div style:transform="scale({scale})" style:transform-origin="top left">
            <PosterCanvas
              bind:el={posterEl}
              {model}
              {content}
              bubbles={positioned}
              {decorations}
              {theme}
              {background}
              {canvasHeight}
              {directoryVisible}
              editable
              viewScale={scale}
              {selectedId}
              {selectedDecorationId}
              title={project.name}
              onSelect={(id) => (selectedId = id)}
              onSelectDecoration={(id) => (selectedDecorationId = id)}
              onChange={patchBubble}
              onChangeDecoration={patchDecoration}
            />
          </div>
        </div>

        <!-- Settings + per-bubble property panel -->
        <div class="space-y-4">
          <section class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-4 space-y-4">
            <h3 class="text-sm font-bold text-text-main">{m.carte_settings_heading()}</h3>

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

            <label class="inline-flex items-center gap-2 text-xs font-semibold text-text-muted">
              <input type="checkbox" bind:checked={directoryVisible} class="accent-cn-yellow" />
              {m.carte_directory_toggle()}
            </label>

            <p class="text-xs text-text-muted">{m.carte_editor_hint()}</p>
            <p class="text-xs text-text-muted">{m.carte_generated_note()}</p>
          </section>

          <!-- Add-element palette -->
          <section class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-4 space-y-3">
            <h3 class="text-sm font-bold text-text-main">{m.carte_elements_heading()}</h3>
            <button
              type="button"
              onclick={addText}
              class="inline-flex items-center gap-2 rounded-xl border border-cn-border px-3 py-1.5 text-sm font-semibold text-text-main hover:bg-cn-bg"
            >
              <Type size={15} />
              {m.carte_add_text()}
            </button>
          </section>

          {#if selectedDecoration}
            <!-- Selected-decoration property panel -->
            <section
              class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-4 space-y-3"
            >
              <h3 class="text-sm font-bold text-text-main">{m.carte_deco_heading()}</h3>

              {#if selectedTextDeco}
                <label class="block space-y-1">
                  <span class="block text-xs font-semibold text-text-muted"
                    >{m.carte_deco_content()}</span
                  >
                  <textarea
                    value={selectedTextDeco.content}
                    oninput={(e) =>
                      patchDecoration(selectedTextDeco.id, { content: e.currentTarget.value })}
                    rows="2"
                    class="w-full resize-y rounded-lg border border-cn-border bg-transparent px-2 py-1.5 text-sm text-text-main"
                  ></textarea>
                </label>
              {/if}

              <div class="flex flex-wrap items-center gap-3">
                <label class="flex items-center gap-2 text-xs font-semibold text-text-muted">
                  {m.carte_panel_color()}
                  <input
                    type="color"
                    value={selectedDecoration.color}
                    oninput={(e) =>
                      patchDecoration(selectedDecoration.id, { color: e.currentTarget.value })}
                    class="h-7 w-10 cursor-pointer rounded border border-cn-border bg-transparent"
                  />
                </label>
                {#if selectedTextDeco}
                  <label class="flex items-center gap-2 text-xs font-semibold text-text-muted">
                    <input
                      type="checkbox"
                      checked={selectedTextDeco.bold}
                      onchange={(e) =>
                        patchDecoration(selectedTextDeco.id, { bold: e.currentTarget.checked })}
                      class="accent-cn-yellow"
                    />
                    {m.carte_deco_bold()}
                  </label>
                {/if}
              </div>

              {#if selectedTextDeco}
                <div class="flex flex-wrap items-center gap-1.5">
                  {#each [{ v: 'left', icon: AlignLeft, label: m.carte_align_left() }, { v: 'center', icon: AlignCenter, label: m.carte_align_center() }, { v: 'right', icon: AlignRight, label: m.carte_align_right() }] as opt (opt.v)}
                    <button
                      type="button"
                      aria-label={opt.label}
                      onclick={() =>
                        patchDecoration(selectedTextDeco.id, {
                          align: opt.v as 'left' | 'center' | 'right',
                        })}
                      class="inline-flex items-center justify-center rounded-lg border px-2 py-1 transition-colors
                      {selectedTextDeco.align === opt.v
                        ? 'border-cn-yellow bg-cn-yellow/15 text-cn-dark'
                        : 'border-cn-border text-text-muted hover:text-text-main'}"
                    >
                      <opt.icon size={14} />
                    </button>
                  {/each}
                </div>
              {/if}

              <div class="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onclick={() => decoBringToFront(selectedDecoration.id)}
                  class="inline-flex items-center gap-1.5 rounded-lg border border-cn-border px-2.5 py-1 text-xs font-semibold text-text-muted hover:text-text-main"
                >
                  <BringToFront size={13} />
                  {m.carte_panel_front()}
                </button>
                <button
                  type="button"
                  onclick={() => decoSendToBack(selectedDecoration.id)}
                  class="inline-flex items-center gap-1.5 rounded-lg border border-cn-border px-2.5 py-1 text-xs font-semibold text-text-muted hover:text-text-main"
                >
                  <SendToBack size={13} />
                  {m.carte_panel_back()}
                </button>
                <button
                  type="button"
                  onclick={() => deleteDecoration(selectedDecoration.id)}
                  class="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 px-2.5 py-1 text-xs font-semibold text-red-500 hover:bg-red-500/10"
                >
                  <Trash2 size={13} />
                  {m.carte_deco_delete()}
                </button>
              </div>
            </section>
          {/if}

          <!-- Selected-bubble property panel -->
          <section class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-4 space-y-3">
            <h3 class="text-sm font-bold text-text-main">{m.carte_panel_heading()}</h3>
            {#if selectedBubble && selectedContent}
              <p class="text-sm font-extrabold text-text-main">{selectedContent.name}</p>

              <label class="flex items-center gap-2 text-xs font-semibold text-text-muted">
                {m.carte_panel_color()}
                <input
                  type="color"
                  value={selectedBubble.colorOverride ?? selectedContent.color}
                  oninput={(e) =>
                    patchBubble(selectedBubble.assoId, { colorOverride: e.currentTarget.value })}
                  class="h-7 w-10 cursor-pointer rounded border border-cn-border bg-transparent"
                />
                {#if selectedBubble.colorOverride}
                  <button
                    type="button"
                    onclick={() => patchBubble(selectedBubble.assoId, { colorOverride: null })}
                    class="text-text-muted underline hover:text-text-main"
                  >
                    {m.carte_panel_color_reset()}
                  </button>
                {/if}
              </label>

              {#if selectedContent.president}
                <label class="flex items-center gap-2 text-xs font-semibold text-text-muted">
                  <input
                    type="checkbox"
                    checked={selectedBubble.showPresident}
                    onchange={(e) =>
                      patchBubble(selectedBubble.assoId, {
                        showPresident: e.currentTarget.checked,
                      })}
                    class="accent-cn-yellow"
                  />
                  {m.carte_panel_president_toggle()}
                </label>
              {/if}

              <div class="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onclick={() => bringToFront(selectedBubble.assoId)}
                  class="inline-flex items-center gap-1.5 rounded-lg border border-cn-border px-2.5 py-1 text-xs font-semibold text-text-muted hover:text-text-main"
                >
                  <BringToFront size={13} />
                  {m.carte_panel_front()}
                </button>
                <button
                  type="button"
                  onclick={() => sendToBack(selectedBubble.assoId)}
                  class="inline-flex items-center gap-1.5 rounded-lg border border-cn-border px-2.5 py-1 text-xs font-semibold text-text-muted hover:text-text-main"
                >
                  <SendToBack size={13} />
                  {m.carte_panel_back()}
                </button>
                <button
                  type="button"
                  onclick={() => resetBubble(selectedBubble.assoId)}
                  class="inline-flex items-center gap-1.5 rounded-lg border border-cn-border px-2.5 py-1 text-xs font-semibold text-text-muted hover:text-text-main"
                >
                  <RotateCcw size={13} />
                  {m.carte_panel_reset()}
                </button>
              </div>
            {:else}
              <p class="text-xs text-text-muted">{m.carte_panel_empty()}</p>
            {/if}
          </section>
        </div>
      </div>
    {/if}
  </div>
{/if}
