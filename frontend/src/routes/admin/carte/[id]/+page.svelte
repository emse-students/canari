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
    DEFAULT_CARTE_DEBUG_TUNING,
    type CarteDebugTuning,
    mergeBubbleLayout,
    seedBubbleLayout,
    indexBubbleContent,
    createTextDecoration,
    sanitizeDecorations,
    STAGE_HEIGHT,
    TEXT_BASE_WIDTH,
    type PositionedBubble,
    type Decoration,
  } from '$lib/carte/layout';
  import { CARTE_SHAPES, shapeRadius, LOGO_SHAPES, logoShape } from '$lib/carte/shapes';
  import { exportPosterPdf } from '$lib/carte/export';
  import PosterCanvas from '$lib/components/carte/PosterCanvas.svelte';
  import ColorPicker from '$lib/components/ui/ColorPicker.svelte';
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
    ZoomIn,
    ZoomOut,
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
  /** Poster title color (persisted override of the theme default). */
  let titleColor = $state(CARTE_STYLE.titleColor);
  /** Runtime debug tuning for the poster geometry/text sizes. */
  let debugTuning = $state<CarteDebugTuning>({ ...DEFAULT_CARTE_DEBUG_TUNING });
  // Single fixed poster style (the theme picker was dropped); the bg image, if any, replaces it.
  // Only the title color is author-overridable, so the theme is derived from it.
  const theme = $derived({ ...CARTE_STYLE, titleColor });

  const DEBUG_STORAGE_PREFIX = 'canari_carte_debug_tuning:';
  const DEBUG_CONTROLS = [
    { key: 'bureauCrownCy', label: 'Couronne - centre Y', min: 60, max: 180, step: 1 },
    { key: 'bureauCrownRx', label: 'Couronne - rayon X', min: 60, max: 200, step: 1 },
    { key: 'bureauCrownRy', label: 'Couronne - rayon Y', min: 120, max: 240, step: 1 },
    {
      key: 'bureauCrownCenterGap',
      label: 'Couronne - trou central',
      min: 0.05,
      max: 0.6,
      step: 0.01,
    },
    {
      key: 'bureauCrownBottomGap',
      label: 'Couronne - angle bas',
      min: -1.5,
      max: 1.2,
      step: 0.01,
    },
    { key: 'bureauCardWidth', label: 'Carte bureau - largeur', min: 48, max: 90, step: 1 },
    {
      key: 'presidentCardWidth',
      label: 'Carte président - largeur',
      min: 60,
      max: 120,
      step: 1,
    },
    {
      key: 'associationNameScale',
      label: 'Nom association - échelle',
      min: 0.5,
      max: 1.15,
      step: 0.01,
    },
    {
      key: 'memberNameScale',
      label: 'Nom membre - échelle',
      min: 0.5,
      max: 1.15,
      step: 0.01,
    },
    {
      key: 'memberRoleScale',
      label: 'Rôle membre - échelle',
      min: 0.5,
      max: 1.15,
      step: 0.01,
    },
  ] as const satisfies ReadonlyArray<{
    key: keyof CarteDebugTuning;
    label: string;
    min: number;
    max: number;
    step: number;
  }>;

  function cloneDefaultDebugTuning(): CarteDebugTuning {
    return { ...DEFAULT_CARTE_DEBUG_TUNING };
  }

  function debugStorageKey(projectId: string): string {
    return `${DEBUG_STORAGE_PREFIX}${projectId}`;
  }

  function sanitizeDebugTuning(raw: unknown): CarteDebugTuning {
    const fallback = cloneDefaultDebugTuning();
    if (!raw || typeof raw !== 'object') return fallback;
    const record = raw as Record<string, unknown>;
    return {
      bureauCrownCy:
        typeof record.bureauCrownCy === 'number' ? record.bureauCrownCy : fallback.bureauCrownCy,
      bureauCrownRx:
        typeof record.bureauCrownRx === 'number' ? record.bureauCrownRx : fallback.bureauCrownRx,
      bureauCrownRy:
        typeof record.bureauCrownRy === 'number' ? record.bureauCrownRy : fallback.bureauCrownRy,
      bureauCrownCenterGap:
        typeof record.bureauCrownCenterGap === 'number'
          ? record.bureauCrownCenterGap
          : fallback.bureauCrownCenterGap,
      bureauCrownBottomGap:
        typeof record.bureauCrownBottomGap === 'number'
          ? record.bureauCrownBottomGap
          : fallback.bureauCrownBottomGap,
      bureauCardWidth:
        typeof record.bureauCardWidth === 'number'
          ? record.bureauCardWidth
          : fallback.bureauCardWidth,
      presidentCardWidth:
        typeof record.presidentCardWidth === 'number'
          ? record.presidentCardWidth
          : fallback.presidentCardWidth,
      associationNameScale:
        typeof record.associationNameScale === 'number'
          ? record.associationNameScale
          : fallback.associationNameScale,
      memberNameScale:
        typeof record.memberNameScale === 'number'
          ? record.memberNameScale
          : fallback.memberNameScale,
      memberRoleScale:
        typeof record.memberRoleScale === 'number'
          ? record.memberRoleScale
          : fallback.memberRoleScale,
    };
  }

  function loadDebugTuning(projectId: string): CarteDebugTuning {
    if (typeof localStorage === 'undefined') return cloneDefaultDebugTuning();
    try {
      const stored = localStorage.getItem(debugStorageKey(projectId));
      if (!stored) return cloneDefaultDebugTuning();
      return sanitizeDebugTuning(JSON.parse(stored));
    } catch {
      return cloneDefaultDebugTuning();
    }
  }

  function saveDebugTuning(projectId: string, tuning: CarteDebugTuning) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(debugStorageKey(projectId), JSON.stringify(tuning));
    } catch {
      // Ignore storage failures in the debug panel.
    }
  }

  function setDebugTuningValue(key: keyof CarteDebugTuning, value: number) {
    debugTuning = { ...debugTuning, [key]: value };
  }

  function formatDebugValue(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }

  // ── Freeform bubble placement (persisted as layout.bubbles) ───────────────────
  let positioned = $state<PositionedBubble[]>([]);
  let selectedId = $state<string | null>(null);

  // ── Free-form decorations (persisted as layout.decorations) ───────────────────
  let decorations = $state<Decoration[]>([]);
  let selectedDecorationId = $state<string | null>(null);

  let saving = $state(false);
  let saved = $state(false);
  let exporting = $state(false);
  /** True once a project has finished loading, so autosave never fires on the initial hydration. */
  let hydrated = $state(false);
  /** Pending debounced-autosave timer (cleared on every change). */
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;

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
  const selectedBubble = $derived(positioned.find((b) => b.assoId === selectedId) ?? null);
  const selectedContent = $derived(selectedId ? content[selectedId] : undefined);
  const selectedDecoration = $derived(
    decorations.find((d) => d.id === selectedDecorationId) ?? null
  );
  /** The selected decoration narrowed to a text box, or null (drives the text-only controls). */
  const selectedTextDeco = $derived(
    selectedDecoration?.kind === 'text' ? selectedDecoration : null
  );

  // ── Scaled preview (poster renders at its natural A2 frame, scaled to fit the column width) ──
  let previewWidth = $state(0);
  let posterEl = $state<HTMLElement>();
  /** User zoom multiplier on top of the fit-to-width scale (1 = fit; >1 scrolls the preview). */
  let zoom = $state(1);
  const MIN_ZOOM = 0.4;
  const MAX_ZOOM = 4;
  /** Scale that fits the whole A2 width into the preview column. */
  const fitScale = $derived(previewWidth > 0 ? Math.min(1, previewWidth / 1600) : 1);
  /** Effective on-screen scale (fit * zoom); drives the poster transform + pointer math. */
  const viewScale = $derived(fitScale * zoom);
  // The wrapper keeps the fit height so the page layout is stable; zoom overflows + scrolls inside.
  const previewHeight = $derived(STAGE_HEIGHT * fitScale);

  function zoomBy(delta: number) {
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((zoom + delta) * 100) / 100));
  }

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
      titleColor =
        typeof layout.titleColor === 'string' ? layout.titleColor : CARTE_STYLE.titleColor;
      debugTuning = loadDebugTuning(proj.id);
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
      // Arm autosave only now, so hydrating the state above doesn't schedule a spurious save.
      hydrated = true;
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
    if (seed) patchBubble(id, { x: seed.x, y: seed.y, scale: seed.scale });
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
        titleColor,
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

  /**
   * Debounced autosave: 4s after the last change to any persisted field, save silently. Reads only
   * the content fields (not `project`), so the save's own `project` update never re-triggers it.
   */
  $effect(() => {
    // Track every persisted field so any edit re-arms the timer.
    void positioned;
    void decorations;
    void bgDataUrl;
    void scrimOpacity;
    void directoryVisible;
    void titleColor;
    if (!hydrated) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => void handleSave(), 4000);
    return () => clearTimeout(autosaveTimer);
  });

  $effect(() => {
    void debugTuning;
    if (!project) return;
    saveDebugTuning(project.id, debugTuning);
  });

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
        <!-- Poster preview column: a zoom toolbar above a scrollable, fit-height stage. -->
        <div class="space-y-2">
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              onclick={() => zoomBy(-0.25)}
              aria-label={m.carte_zoom_out()}
              class="inline-flex items-center justify-center rounded-lg border border-cn-border p-1.5 text-text-muted hover:text-text-main hover:bg-cn-bg"
            >
              <ZoomOut size={15} />
            </button>
            <button
              type="button"
              onclick={() => (zoom = 1)}
              class="min-w-[3.5rem] rounded-lg border border-cn-border px-2 py-1 text-xs font-semibold text-text-muted hover:text-text-main hover:bg-cn-bg"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              onclick={() => zoomBy(0.25)}
              aria-label={m.carte_zoom_in()}
              class="inline-flex items-center justify-center rounded-lg border border-cn-border p-1.5 text-text-muted hover:text-text-main hover:bg-cn-bg"
            >
              <ZoomIn size={15} />
            </button>
          </div>
          <!-- Scrollable stage: the outer div is sized to the scaled poster so zoom overflows +
               scrolls; the inner (un-scaled) element is the exact node captured for PDF export. -->
          <div
            bind:clientWidth={previewWidth}
            class="overflow-auto rounded-2xl border border-cn-border"
            style:height="{previewHeight}px"
          >
            <div style:width="{1600 * viewScale}px" style:height="{STAGE_HEIGHT * viewScale}px">
              <div
                style:transform="scale({viewScale})"
                style:transform-origin="top left"
                style:width="1600px"
                style:height="{STAGE_HEIGHT}px"
              >
                <PosterCanvas
                  bind:el={posterEl}
                  {model}
                  {content}
                  bubbles={positioned}
                  {decorations}
                  {theme}
                  {background}
                  {directoryVisible}
                  {debugTuning}
                  editable
                  {viewScale}
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
          </div>
        </div>

        <!-- Settings + per-bubble property panel -->
        <div class="space-y-4">
          <section class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-4 space-y-4">
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-sm font-bold text-text-main">
                {m.carte_settings_heading()}
              </h3>
              <button
                type="button"
                onclick={toggleFullPage}
                class="inline-flex items-center gap-1.5 rounded-lg border border-cn-border px-2.5 py-1 text-xs font-semibold text-text-muted hover:text-text-main hover:bg-cn-bg"
              >
                {#if isFullPage}
                  <Minimize size={14} />
                  {m.carte_fullpage_exit()}
                {:else}
                  <Maximize size={14} />
                  {m.carte_fullpage_enter()}
                {/if}
              </button>
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

            <label class="inline-flex items-center gap-2 text-xs font-semibold text-text-muted">
              <input type="checkbox" bind:checked={directoryVisible} class="accent-cn-yellow" />
              {m.carte_directory_toggle()}
            </label>

            <div class="flex items-center gap-2 text-xs font-semibold text-text-muted">
              <span>{m.carte_title_color_label()}</span>
              <ColorPicker bind:value={titleColor} label={m.carte_title_color_label()} />
            </div>

            <details class="rounded-xl border border-cn-border px-3 py-2" open>
              <summary class="cursor-pointer text-xs font-semibold text-text-muted">
                Debug géométrie
              </summary>
              <div class="mt-3 space-y-3">
                {#each DEBUG_CONTROLS as control (control.key)}
                  <label class="block space-y-1.5">
                    <div
                      class="flex items-center justify-between gap-3 text-[11px] font-semibold text-text-muted"
                    >
                      <span>{control.label}</span>
                      <span class="tabular-nums text-text-main">
                        {formatDebugValue(debugTuning[control.key])}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={control.min}
                      max={control.max}
                      step={control.step}
                      value={debugTuning[control.key]}
                      oninput={(e) =>
                        setDebugTuningValue(
                          control.key,
                          Number((e.currentTarget as HTMLInputElement).value)
                        )}
                      class="w-full accent-cn-yellow"
                    />
                  </label>
                {/each}
              </div>
            </details>

            <p class="text-xs text-text-muted">{m.carte_editor_hint()}</p>
            <p class="text-xs text-text-muted">{m.carte_generated_note()}</p>
          </section>

          <!-- Add-element palette -->
          <section class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] p-4 space-y-3">
            <h3 class="text-sm font-bold text-text-main">
              {m.carte_elements_heading()}
            </h3>
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
              <h3 class="text-sm font-bold text-text-main">
                {m.carte_deco_heading()}
              </h3>

              {#if selectedTextDeco}
                <label class="block space-y-1">
                  <span class="block text-xs font-semibold text-text-muted"
                    >{m.carte_deco_content()}</span
                  >
                  <textarea
                    value={selectedTextDeco.content}
                    oninput={(e) =>
                      patchDecoration(selectedTextDeco.id, {
                        content: e.currentTarget.value,
                      })}
                    rows="2"
                    class="w-full resize-y rounded-lg border border-cn-border bg-transparent px-2 py-1.5 text-sm text-text-main"
                  ></textarea>
                </label>
              {/if}

              <div class="flex flex-wrap items-center gap-3">
                <div class="flex items-center gap-2 text-xs font-semibold text-text-muted">
                  {m.carte_panel_color()}
                  <ColorPicker
                    value={selectedDecoration.color}
                    label={m.carte_panel_color()}
                    onChange={(hex) => patchDecoration(selectedDecoration.id, { color: hex })}
                  />
                </div>
                {#if selectedTextDeco}
                  <label class="flex items-center gap-2 text-xs font-semibold text-text-muted">
                    <input
                      type="checkbox"
                      checked={selectedTextDeco.bold}
                      onchange={(e) =>
                        patchDecoration(selectedTextDeco.id, {
                          bold: e.currentTarget.checked,
                        })}
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
            <h3 class="text-sm font-bold text-text-main">
              {m.carte_panel_heading()}
            </h3>
            {#if selectedBubble && selectedContent}
              <p class="text-sm font-extrabold text-text-main">
                {selectedContent.name}
              </p>

              <div class="flex items-center gap-2 text-xs font-semibold text-text-muted">
                {m.carte_panel_color()}
                <ColorPicker
                  value={selectedBubble.colorOverride ?? selectedContent.color}
                  label={m.carte_panel_color()}
                  onChange={(hex) => patchBubble(selectedBubble.assoId, { colorOverride: hex })}
                />
                {#if selectedBubble.colorOverride}
                  <button
                    type="button"
                    onclick={() =>
                      patchBubble(selectedBubble.assoId, {
                        colorOverride: null,
                      })}
                    class="text-text-muted underline hover:text-text-main"
                  >
                    {m.carte_panel_color_reset()}
                  </button>
                {/if}
              </div>

              <div class="space-y-1.5">
                <span class="block text-xs font-semibold text-text-muted"
                  >{m.carte_shape_label()}</span
                >
                <div class="flex flex-wrap gap-1.5">
                  {#each CARTE_SHAPES as sh, i (sh.key)}
                    <button
                      type="button"
                      aria-label={m.carte_shape_option({ n: i + 1 })}
                      onclick={() => patchBubble(selectedBubble.assoId, { shape: sh.key })}
                      class="h-8 w-8 border p-1 transition-colors {selectedBubble.shape === sh.key
                        ? 'border-cn-yellow text-cn-yellow'
                        : 'border-cn-border text-text-muted hover:text-text-main'}"
                    >
                      <span
                        class="block h-full w-full bg-current"
                        style:border-radius={shapeRadius(sh.key)}
                      ></span>
                    </button>
                  {/each}
                </div>
              </div>

              <div class="space-y-1.5">
                <span class="block text-xs font-semibold text-text-muted"
                  >{m.carte_logo_shape_label()}</span
                >
                <div class="flex flex-wrap gap-1.5">
                  {#each LOGO_SHAPES as ls, i (ls.key)}
                    {@const max = Math.max(ls.w, ls.h)}
                    <button
                      type="button"
                      aria-label={m.carte_logo_shape_option({ n: i + 1 })}
                      onclick={() =>
                        patchBubble(selectedBubble.assoId, {
                          logoShape: ls.key,
                        })}
                      class="flex h-8 w-8 items-center justify-center border p-1 transition-colors {selectedBubble.logoShape ===
                      ls.key
                        ? 'border-cn-yellow text-cn-yellow'
                        : 'border-cn-border text-text-muted hover:text-text-main'}"
                    >
                      <span
                        class="block bg-current"
                        style:width="{(ls.w / max) * 100}%"
                        style:height="{(ls.h / max) * 100}%"
                        style:border-radius={logoShape(ls.key).radius}
                      ></span>
                    </button>
                  {/each}
                </div>
              </div>

              <div class="space-y-1.5 pt-2 border-t border-cn-border">
                <span class="block text-xs font-semibold text-text-muted">Membres affichés</span>
                <div class="space-y-1">
                  {#if selectedContent.president}
                    <label class="flex items-center gap-2 text-xs text-text-main">
                      <input
                        type="checkbox"
                        checked={selectedBubble.showPresident !== false}
                        onchange={(e) =>
                          patchBubble(selectedBubble.assoId, {
                            showPresident: e.currentTarget.checked,
                          })}
                        class="accent-cn-yellow"
                      />
                      {selectedContent.president.name} (Président)
                    </label>
                  {/if}
                  {#each selectedContent.bureau as member (member.userId)}
                    <label class="flex items-center gap-2 text-xs text-text-main">
                      <input
                        type="checkbox"
                        checked={!(selectedBubble.hiddenMembers || []).includes(member.userId)}
                        onchange={(e) => {
                          const hidden = new Set(selectedBubble.hiddenMembers || []);
                          if (e.currentTarget.checked) hidden.delete(member.userId);
                          else hidden.add(member.userId);
                          patchBubble(selectedBubble.assoId, { hiddenMembers: Array.from(hidden) });
                        }}
                        class="accent-cn-yellow"
                      />
                      {member.name}
                    </label>
                  {/each}
                </div>
              </div>

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
