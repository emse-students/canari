<script lang="ts">
  import { Log } from '$lib/utils/Log';
  import { onMount, tick, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { isGlobalAdmin, isAssociationSuperAdmin } from '$lib/stores/user';
  import {
    ensureAssociationSuperAdmin,
    getPosterProject,
    updatePosterProject,
    publishPosterProject,
    unpublishPosterProject,
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
    createTextDecoration,
    sanitizeDecorations,
    findUnitOverlaps,
    unitInkShapes,
    STAGE_HEIGHT,
    TEXT_BASE_WIDTH,
    type PositionedBubble,
    type Decoration,
  } from '$lib/carte/layout';
  import { CARTE_SHAPES, shapeRadius, LOGO_SHAPES, logoShape } from '$lib/carte/shapes';
  import { exportPosterPdf } from '$lib/carte/export';
  import { buildPublishedCarte, fingerprintPublishedCarte } from '$lib/carte/publish';
  import PosterCanvas from '$lib/components/carte/PosterCanvas.svelte';
  import { MonitorSmartphone } from '@lucide/svelte';
  import { isCoarsePointerDevice, onCoarsePointerChange } from '$lib/utils/pointerDevice';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { exactDate } from '$lib/utils/time';
  import { createSerialSaver, layoutFingerprint } from '$lib/carte/editorPersistence';
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
    TextAlignStart,
    TextAlignCenter,
    TextAlignEnd,
    Maximize,
    Minimize,
    ZoomIn,
    ZoomOut,
    Pencil,
    Globe,
    GlobeLock,
    TriangleAlert,
    RefreshCw,
  } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { portalWhile } from '$lib/actions/portal';
  import { coversScreen } from '$lib/actions/coversScreen.svelte';

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
  // Single fixed poster style (the theme picker was dropped); the bg image, if any, replaces it.
  // Only the title color is author-overridable, so the theme is derived from it.
  const theme = $derived({ ...CARTE_STYLE, titleColor });

  // ── Freeform bubble placement (persisted as layout.bubbles) ───────────────────
  let positioned = $state<PositionedBubble[]>([]);
  let selectedId = $state<string | null>(null);

  // ── Free-form decorations (persisted as layout.decorations) ───────────────────
  let decorations = $state<Decoration[]>([]);
  let selectedDecorationId = $state<string | null>(null);

  /** Bumped wherever the background image is replaced or cleared - see `LayoutFingerprintParts`. */
  let bgVersion = $state(0);

  /** The persisted layout, rebuilt from the live editor state. */
  function buildLayout(): PosterLayout {
    return {
      version: 1,
      titleColor,
      background: { dataUrl: bgDataUrl, scrimOpacity },
      bubbles: positioned,
      directoryVisible,
      decorations,
    };
  }

  /** Everything that gets persisted, as one comparable string. */
  const fingerprint = $derived(
    layoutFingerprint({
      titleColor,
      scrimOpacity,
      directoryVisible,
      bubbles: positioned,
      decorations,
      bgVersion,
    })
  );
  /** The fingerprint of the last state the server accepted; null until the project has loaded. */
  let savedFingerprint = $state<string | null>(null);
  /** Whether the editor holds anything the server has not taken yet. */
  const unsavedChanges = $derived(savedFingerprint !== null && fingerprint !== savedFingerprint);

  let saving = $state(false);
  let saved = $state(false);
  let exporting = $state(false);
  let publishing = $state(false);
  /** Whether THIS poster is the one currently live on the showcase (at most one ever is). */
  const isPublished = $derived(Boolean(project?.publishedAt));
  /** When it went live, for the status chip. */
  const publishedOn = $derived(project?.publishedAt ? exactDate(project.publishedAt) : '');

  // ── Inline rename ─────────────────────────────────────────────────────────────
  let editingName = $state(false);
  let editedName = $state('');
  let nameInputEl = $state<HTMLInputElement>();

  function startRenamingName() {
    if (!project) return;
    editedName = project.name;
    editingName = true;
    // Focus the input after Svelte renders it.
    tick().then(() => nameInputEl?.focus());
  }

  async function commitRename() {
    if (!project || !editingName) return;
    const trimmed = editedName.trim();
    editingName = false;
    if (!trimmed || trimmed === project.name) return;
    try {
      project = await updatePosterProject(project.id, { name: trimmed });
    } catch (e) {
      Log.d('admin.carte.id.commitRename failed', e);
      error = m.common_save_error();
    }
  }

  function cancelRename() {
    editingName = false;
  }
  /** Pending debounced-autosave timer (cleared on every change). */
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;

  // ── Full-page editing ─────────────────────────────────────────────────────────
  // An in-app overlay (fixed inset-0) that fills the browser window while keeping its chrome - NOT
  // the Fullscreen API, which hides the whole browser interface.
  //
  // ITS RUNG IS `--z-page-overlay`, AND THAT IS A SENTENCE ABOUT WHAT IT IS: a page's own surface
  // expanded to the window, not a claim against the window. Everything ambient or interruptive
  // stays over it - a toast (60) reporting the autosave, the banner column (120), any sheet or
  // modal opened from here - which is also what the raw `z-50` did, so nothing a user can see
  // changes. What changes is that the number is no longer comparable with nothing: at 50 it sat
  // between two rungs, in the same gap that put the agenda admin's reject dialog under a toast.
  //
  // AND IT IS PORTALLED TO THE BODY WHILE ON (`portalWhile`), because the rung means nothing where it
  // was written: `.page-scroll-wrap` is a containing block (`app.css`), so `fixed inset-0` covered
  // the SCROLLED wrapper, shifted by its scrollTop - measured 2026-09-28 at 219 px, the overlap
  // warning showing under the poster.
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

  // ── Overlapping units ────────────────────────────────────────────────────────
  // Decided with the user on 2026-09-27: an overlap is SHOWN and never repaired. Moving a unit
  // would undo a placement made by hand, and only the author knows which of the two should give
  // way. Six pairs were crossing on the published map without anything ever saying so.

  /** Every pair of units drawn over each other, worst first. */
  const overlaps = $derived(
    findUnitOverlaps(
      positioned.map((bubble) => ({
        assoId: bubble.assoId,
        shapes: unitInkShapes(bubble, content[bubble.assoId]?.members ?? []),
      }))
    )
  );
  /** The units named by at least one crossing, so the stage can outline them. */
  const overlapIds = $derived(new Set(overlaps.flatMap((o) => [o.a, o.b])));
  /**
   * Whether the stage outlines them. Off by default and cleared before an export, for the reason
   * the selection is: the element captured for the PDF is the live editor stage.
   */
  let showOverlaps = $state(false);
  /** An association's name, for the list of crossings. */
  const assoName = (id: string): string => content[id]?.name ?? id;

  /**
   * Associations placed on the poster whose roster is empty.
   *
   * They keep their place (user, D10) - an association with nobody registered on Canari is still an
   * association of the school. The editor names them so their bureau can fill the roster in, since
   * an empty blob and an empty directory line otherwise read as a broken render.
   */
  const memberlessNames = $derived(
    positioned
      .map((bubble) => content[bubble.assoId])
      .filter((asso) => asso !== undefined && asso.members.length === 0)
      .map((asso) => asso.name)
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
      // What was just loaded IS what the server holds, so the editor opens with nothing to save.
      // A flag armed here instead would make opening a project write it back - every open rewrote
      // the layout 4 s later, and a new association was reseeded with a RANDOM shape on the way.
      savedFingerprint = fingerprint;
      // What the LIVE map is, as the server recorded it at its publish. `undefined` from a server
      // that predates the column reads the same as null: unknown.
      liveFingerprint = project?.publicationFingerprint ?? null;
    } catch (e) {
      Log.d('admin.carte.id.loadData failed', e);
      error = m.common_load_error();
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
      bgVersion++;
    };
    reader.readAsDataURL(file);
  }

  /** Writes the current layout to the server. Always called through {@link handleSave}. */
  async function persistLayout(): Promise<void> {
    if (!project) return;
    // Pinned BEFORE the request: anything the author changes while it is in flight must still read
    // as unsaved afterwards, which recording the post-response state would quietly swallow.
    const pinned = fingerprint;
    Log.d('admin.carte.id.persistLayout', { projectId: project.id });
    saving = true;
    saved = false;
    error = null;
    try {
      project = await updatePosterProject(project.id, {
        layout: buildLayout() as unknown as Record<string, unknown>,
      });
      savedFingerprint = pinned;
      saved = true;
      setTimeout(() => (saved = false), 2500);
    } catch (e) {
      Log.d('admin.carte.id.persistLayout failed', e);
      error = m.common_save_error();
      throw e;
    } finally {
      saving = false;
    }
  }

  /**
   * Saves, BEHIND whatever save is already in flight.
   *
   * It used to return immediately while one was running, which is what let a publish send a state
   * the server had never been given: `handlePublish` saves first precisely so the live map can be
   * reproduced by reopening the project, and that guarantee died on the early return.
   *
   * @returns Whether the layout is now on the server; false means the error is already on screen.
   */
  const saver = createSerialSaver(persistLayout);
  const handleSave = (): Promise<boolean> => saver.save();

  /**
   * Debounced autosave: 4 s after the last CHANGE, save silently. It is armed by the state
   * differing from what the server holds, so merely opening a project arms nothing.
   */
  $effect(() => {
    if (!unsavedChanges) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => void handleSave(), 4000);
    return () => clearTimeout(autosaveTimer);
  });

  /** Everything `buildPublishedCarte` needs, in ONE place: publishing and the staleness check must
   * describe the same document, or the badge would answer about a map nobody would publish. */
  const publishParams = () => ({
    bubbles: positioned,
    content,
    model: model ?? { zones: [], totalAssos: 0 },
    decorations,
    background: { dataUrl: bgDataUrl, scrimOpacity },
    style: theme,
    title: project?.name ?? '',
    directoryVisible,
    directoryHeading: m.carte_directory_heading(),
  });

  /**
   * The fingerprint of the map that is LIVE, and the one this editor would publish now.
   *
   * `liveFingerprint` is null when nothing is published, and also when the live map was published
   * by a client older than the fingerprint - which is why "unknown" and "unchanged" are kept
   * apart below rather than both reading as "nothing to do".
   */
  let liveFingerprint = $state<string | null>(null);
  let savedFingerprintValue = $state<string | null>(null);
  /** True only when BOTH are known AND they differ: an unknown answers nothing. */
  const publicationStale = $derived(
    liveFingerprint !== null &&
      savedFingerprintValue !== null &&
      liveFingerprint !== savedFingerprintValue
  );

  /**
   * Recomputes the fingerprint of what would be published.
   *
   * Runs when the SAVED state changes, never on a pointer frame: the document carries the
   * background image, which can be several megabytes.
   */
  async function refreshPublishFingerprint(): Promise<void> {
    if (!project || !model) return;
    try {
      savedFingerprintValue = await fingerprintPublishedCarte(buildPublishedCarte(publishParams()));
    } catch (e) {
      // Never leaves a stale answer behind: an unknown reads as "cannot say", not "unchanged".
      Log.d('admin.carte.id.refreshPublishFingerprint failed', e);
      savedFingerprintValue = null;
    }
  }

  // The saved state is what the fingerprint describes, so it is recomputed when THAT settles - on
  // load and after each save - rather than on every edit.
  //
  // `untrack` is load-bearing, not decoration: `publishParams()` runs synchronously here and reads
  // every bubble, decoration and the background, so without it this effect would re-run on every
  // pointer frame of a drag and hash several megabytes each time.
  $effect(() => {
    void savedFingerprint;
    untrack(() => void refreshPublishFingerprint());
  });

  /**
   * Publishes this poster to the public showcase (portail-etu), replacing whatever was live - the
   * server allows exactly one published map at a time.
   */
  async function handlePublish() {
    if (!project || publishing) return;
    Log.d('admin.carte.id.handlePublish', { projectId: project.id });
    publishing = true;
    error = null;
    try {
      // A publish saves FIRST, and abandons if that save failed: putting a map online that no
      // reopen could reproduce is worse than not publishing at all.
      if (!(await handleSave())) return;
      const carte = buildPublishedCarte(publishParams());
      const fingerprint = await fingerprintPublishedCarte(carte);
      project = await publishPosterProject(project.id, carte, fingerprint);
      liveFingerprint = fingerprint;
    } catch (e) {
      Log.d('admin.carte.id.handlePublish failed', e);
      error = m.common_save_error();
    } finally {
      publishing = false;
    }
  }

  /**
   * Takes this poster off the showcase, on its own confirmed action.
   *
   * It is deliberately NOT the other face of a toggle: being live is a STATE, and the control that
   * ends it destroys the only map the portail has - after which the portail shows none at all.
   * One misread click did that silently.
   */
  async function handleUnpublish() {
    if (!project || publishing) return;
    if (
      !(await showConfirm(m.carte_unpublish_confirm(), {
        danger: true,
        confirmLabel: m.carte_unpublish_button(),
      }))
    )
      return;
    Log.d('admin.carte.id.handleUnpublish', { projectId: project.id });
    publishing = true;
    error = null;
    try {
      project = await unpublishPosterProject(project.id);
    } catch (e) {
      Log.d('admin.carte.id.handleUnpublish failed', e);
      error = m.common_save_error();
    } finally {
      publishing = false;
    }
  }

  async function handleExport() {
    if (!posterEl || !project || exporting) return;
    exporting = true;
    error = null;
    // Clear selections and the overlap outlines so none of them is captured in the PDF.
    selectedId = null;
    selectedDecorationId = null;
    showOverlaps = false;
    await tick();
    try {
      await exportPosterPdf(posterEl, project.name);
    } catch (e) {
      Log.d('admin.carte.id.handleExport failed', e);
      error = m.common_generic_error_label();
    } finally {
      exporting = false;
    }
  }

  /**
   * Arranging bubbles means dragging and resizing objects a finger covers while it moves them, on a
   * poster wider than any phone. The editor is therefore offered to a mouse only - the poster stays
   * viewable, exportable and publishable everywhere. Asked for on 2026-08-27: *"j'aimerais rendre
   * l'edition impossible sur mobile, trop complexe, il faut ne la rendre possible que sur le PC."*
   *
   * The pointer decides, not the width: a narrow desktop window still has a mouse.
   */
  let coarsePointer = $state(false);
  const canEdit = $derived(!coarsePointer);

  // An `$effect` rather than `onMount`: this one is async, and Svelte honours a returned teardown
  // only from a synchronous `onMount`. The subscription would never be detached.
  $effect(() => {
    coarsePointer = isCoarsePointerDevice();
    return onCoarsePointerChange((coarse) => (coarsePointer = coarse));
  });

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
      class="text-text-muted hover:text-text-main inline-flex items-center gap-1 text-sm transition-colors"
    >
      <ArrowLeft size={14} />
      {m.carte_editor_back()}
    </a>

    {#if loading}
      <div class="flex justify-center py-16">
        <div
          class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
        ></div>
      </div>
    {:else if error && !project}
      <p class="text-sm text-red-500" role="alert">{error}</p>
    {:else if project && model}
      <header class="flex flex-wrap items-center justify-between gap-3">
        {#if !canEdit}
          <h2 class="text-text-main text-lg font-bold">{project.name}</h2>
        {:else if editingName}
          <input
            bind:this={nameInputEl}
            bind:value={editedName}
            onblur={commitRename}
            onkeydown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') cancelRename();
            }}
            maxlength={120}
            class="text-text-main border-cn-yellow border-b-2 bg-transparent px-0 py-0 text-lg font-bold outline-none"
            style="min-width:120px;max-width:400px;width:{Math.max(120, editedName.length * 10)}px;"
          />
        {:else}
          <button
            type="button"
            class="group text-text-main hover:text-cn-yellow flex items-center gap-2 text-lg font-bold transition-colors"
            onclick={startRenamingName}
            title="Renommer le projet"
          >
            {project.name}
            <Pencil size={14} class="opacity-0 transition-opacity group-hover:opacity-60" />
          </button>
        {/if}
        <div class="flex items-center gap-2">
          {#if canEdit}
            <button
              type="button"
              onclick={handleSave}
              disabled={saving}
              class="border-cn-border text-text-main hover:bg-cn-bg inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-bold disabled:opacity-50"
            >
              {#if saved}
                <Check size={16} />
                {m.carte_saved_label()}
              {:else}
                <Save size={16} />
                {saving
                  ? m.carte_saving_label()
                  : unsavedChanges
                    ? m.carte_unsaved_label()
                    : m.carte_save_button()}
              {/if}
            </button>
          {/if}
          <!-- BEING LIVE IS A STATE, NOT A BUTTON. The status only reports; taking the map off the
               portail is its own action, and it confirms. -->
          {#if isPublished}
            <span
              class="inline-flex items-center gap-2 rounded-xl border border-green-600/40 bg-green-600/10 px-3 py-2 text-sm font-bold text-green-700 dark:text-green-400"
            >
              <Globe size={16} />
              {m.carte_published_since({ date: publishedOn })}
            </span>
            <!-- The live map is older than what is saved. Nothing republishes on its own: an
                 autosave that reached the portail would put half-arranged layouts online (D2). -->
            {#if publicationStale}
              <button
                type="button"
                onclick={handlePublish}
                disabled={publishing}
                title={m.carte_publish_update_hint()}
                class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
              >
                <RefreshCw size={16} />
                {publishing ? m.carte_publishing_label() : m.carte_publish_update_button()}
              </button>
            {/if}
            <button
              type="button"
              onclick={handleUnpublish}
              disabled={publishing}
              title={m.carte_unpublish_hint()}
              class="border-cn-border text-text-muted hover:text-text-main hover:bg-cn-bg inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-bold disabled:opacity-50"
            >
              <GlobeLock size={16} />
              {publishing ? m.carte_publishing_label() : m.carte_unpublish_button()}
            </button>
          {:else}
            <button
              type="button"
              onclick={handlePublish}
              disabled={publishing}
              title={m.carte_publish_hint()}
              class="border-cn-border text-text-main hover:bg-cn-bg inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-bold disabled:opacity-50"
            >
              <Globe size={16} />
              {publishing ? m.carte_publishing_label() : m.carte_publish_button()}
            </button>
          {/if}
          <button
            type="button"
            onclick={handleExport}
            disabled={exporting}
            class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
          >
            <Download size={16} />
            {exporting ? m.carte_exporting_label() : m.carte_export_button()}
          </button>
        </div>
      </header>

      {#if error}
        <p class="text-sm text-red-500" role="alert">{error}</p>
      {/if}

      <!-- A background tab throttles the animation frames the capture runs on, and an export that
           took minutes looked like a hung button. Say so while it runs. -->
      {#if exporting}
        <p class="text-text-muted text-sm">{m.carte_export_foreground_hint()}</p>
      {/if}

      <!-- Associations whose roster is empty. They stay on the poster (D10) - this is for their
           bureau to act on, and an empty blob otherwise looks like a broken render. -->
      {#if canEdit && memberlessNames.length > 0}
        <div
          class="border-cn-border bg-cn-surface-alt flex items-start gap-3 rounded-2xl border p-4"
        >
          <TriangleAlert size={18} class="text-text-muted mt-0.5 shrink-0" />
          <div class="min-w-0">
            <p class="text-text-main text-sm font-bold">
              {m.carte_no_members_title({ count: memberlessNames.length })}
            </p>
            <p class="text-text-muted mt-0.5 text-sm">{m.carte_no_members_body()}</p>
            <p class="text-text-muted mt-1.5 text-sm">{memberlessNames.join(' - ')}</p>
          </div>
        </div>
      {/if}

      <!-- Units drawn over each other. Listed and outlined on demand; never moved (D7). -->
      {#if canEdit && overlaps.length > 0}
        <div
          class="border-cn-border bg-cn-surface-alt flex items-start gap-3 rounded-2xl border p-4"
        >
          <TriangleAlert size={18} class="text-cn-yellow mt-0.5 shrink-0" />
          <div class="min-w-0">
            <p class="text-text-main text-sm font-bold">
              {m.carte_overlaps_title({ count: overlaps.length })}
            </p>
            <p class="text-text-muted mt-0.5 text-sm">{m.carte_overlaps_body()}</p>
            <ul class="text-text-muted mt-1.5 space-y-0.5 text-sm">
              {#each overlaps as pair (pair.a + pair.b)}
                <li>{m.carte_overlaps_pair({ a: assoName(pair.a), b: assoName(pair.b) })}</li>
              {/each}
            </ul>
            <button
              type="button"
              onclick={() => (showOverlaps = !showOverlaps)}
              class="text-text-main mt-2 text-sm font-bold underline"
            >
              {showOverlaps ? m.carte_overlaps_hide() : m.carte_overlaps_show()}
            </button>
          </div>
        </div>
      {/if}

      {#if !canEdit}
        <div
          class="border-cn-border bg-cn-surface-alt flex items-start gap-3 rounded-2xl border p-4"
        >
          <MonitorSmartphone size={18} class="text-text-muted mt-0.5 shrink-0" />
          <div>
            <p class="text-text-main text-sm font-bold">{m.carte_desktop_only_title()}</p>
            <p class="text-text-muted mt-0.5 text-sm">{m.carte_desktop_only_body()}</p>
          </div>
        </div>
      {/if}

      <div
        use:portalWhile={isFullPage}
        use:coversScreen={isFullPage}
        class="grid gap-4 {canEdit ? 'lg:grid-cols-[minmax(0,1fr)_300px]' : ''} {isFullPage
          ? 'bg-cn-bg fixed inset-0 z-(--z-page-overlay) overflow-auto p-5 pt-[max(1.25rem,var(--safe-area-inset-top,0px))]'
          : ''}"
      >
        <!-- Poster preview column: a zoom toolbar above a scrollable, fit-height stage. -->
        <div class="space-y-2">
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              onclick={() => zoomBy(-0.25)}
              aria-label={m.carte_zoom_out()}
              class="ui-icon-button border-cn-border text-text-muted hover:text-text-main hover:bg-cn-bg rounded-lg border"
            >
              <ZoomOut size={15} />
            </button>
            <button
              type="button"
              onclick={() => (zoom = 1)}
              class="border-cn-border text-text-muted hover:text-text-main hover:bg-cn-bg min-w-[3.5rem] rounded-lg border px-2 py-1 text-xs font-semibold"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              onclick={() => zoomBy(0.25)}
              aria-label={m.carte_zoom_in()}
              class="ui-icon-button border-cn-border text-text-muted hover:text-text-main hover:bg-cn-bg rounded-lg border"
            >
              <ZoomIn size={15} />
            </button>
          </div>
          <!-- Scrollable stage: the outer div is sized to the scaled poster so zoom overflows +
               scrolls; the inner (un-scaled) element is the exact node captured for PDF export. -->
          <div
            bind:clientWidth={previewWidth}
            class="border-cn-border overflow-auto rounded-2xl border"
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
                  editable={canEdit}
                  {viewScale}
                  {selectedId}
                  {selectedDecorationId}
                  flaggedIds={showOverlaps ? overlapIds : undefined}
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

        <!-- Settings + per-bubble property panel. Every control in it writes the layout, so the
             column is absent rather than disabled where editing is not offered. -->
        {#if canEdit}
          <div class="space-y-4">
            <section class="border-cn-border space-y-4 rounded-2xl border bg-(--cn-surface) p-4">
              <div class="flex items-center justify-between gap-2">
                <h3 class="text-text-main text-sm font-bold">
                  {m.carte_settings_heading()}
                </h3>
                <button
                  type="button"
                  onclick={toggleFullPage}
                  class="border-cn-border text-text-muted hover:text-text-main hover:bg-cn-bg inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold"
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
                <span class="text-text-muted block text-xs font-semibold"
                  >{m.carte_background_label()}</span
                >
                <label
                  class="border-cn-border text-text-main hover:bg-cn-bg inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-1.5 text-sm font-semibold"
                >
                  <ImagePlus size={15} />
                  {m.carte_background_upload()}
                  <input type="file" accept="image/*" class="hidden" onchange={onBackgroundFile} />
                </label>
                {#if bgDataUrl}
                  <button
                    type="button"
                    onclick={() => {
                      bgDataUrl = null;
                      bgVersion++;
                    }}
                    class="border-cn-border text-text-muted hover:text-text-main inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm font-semibold"
                  >
                    <X size={15} />
                    {m.carte_background_clear()}
                  </button>
                  <label class="text-text-muted inline-flex items-center gap-2 text-xs">
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

              <label class="text-text-muted inline-flex items-center gap-2 text-xs font-semibold">
                <input type="checkbox" bind:checked={directoryVisible} class="accent-cn-yellow" />
                {m.carte_directory_toggle()}
              </label>

              <div class="text-text-muted flex items-center gap-2 text-xs font-semibold">
                <span>{m.carte_title_color_label()}</span>
                <ColorPicker bind:value={titleColor} label={m.carte_title_color_label()} />
              </div>

              <p class="text-text-muted text-xs">{m.carte_editor_hint()}</p>
              <p class="text-text-muted text-xs">{m.carte_generated_note()}</p>
            </section>

            <!-- Add-element palette -->
            <section class="border-cn-border space-y-3 rounded-2xl border bg-(--cn-surface) p-4">
              <h3 class="text-text-main text-sm font-bold">
                {m.carte_elements_heading()}
              </h3>
              <button
                type="button"
                onclick={addText}
                class="border-cn-border text-text-main hover:bg-cn-bg inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 text-sm font-semibold"
              >
                <Type size={15} />
                {m.carte_add_text()}
              </button>
            </section>

            {#if selectedDecoration}
              <!-- Selected-decoration property panel -->
              <section class="border-cn-border space-y-3 rounded-2xl border bg-(--cn-surface) p-4">
                <h3 class="text-text-main text-sm font-bold">
                  {m.carte_deco_heading()}
                </h3>

                {#if selectedTextDeco}
                  <label class="block space-y-1">
                    <span class="text-text-muted block text-xs font-semibold"
                      >{m.carte_deco_content()}</span
                    >
                    <textarea
                      value={selectedTextDeco.content}
                      oninput={(e) =>
                        patchDecoration(selectedTextDeco.id, {
                          content: e.currentTarget.value,
                        })}
                      rows="2"
                      class="border-cn-border text-text-main w-full resize-y rounded-lg border bg-transparent px-2 py-1.5 text-sm"
                    ></textarea>
                  </label>
                {/if}

                <div class="flex flex-wrap items-center gap-3">
                  <div class="text-text-muted flex items-center gap-2 text-xs font-semibold">
                    {m.carte_panel_color()}
                    <ColorPicker
                      value={selectedDecoration.color}
                      label={m.carte_panel_color()}
                      onChange={(hex) => patchDecoration(selectedDecoration.id, { color: hex })}
                    />
                  </div>
                  {#if selectedTextDeco}
                    <label class="text-text-muted flex items-center gap-2 text-xs font-semibold">
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
                    {#each [{ v: 'left', icon: TextAlignStart, label: m.carte_align_left() }, { v: 'center', icon: TextAlignCenter, label: m.carte_align_center() }, { v: 'right', icon: TextAlignEnd, label: m.carte_align_right() }] as opt (opt.v)}
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
                    class="border-cn-border text-text-muted hover:text-text-main inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold"
                  >
                    <BringToFront size={13} />
                    {m.carte_panel_front()}
                  </button>
                  <button
                    type="button"
                    onclick={() => decoSendToBack(selectedDecoration.id)}
                    class="border-cn-border text-text-muted hover:text-text-main inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold"
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
            <section class="border-cn-border space-y-3 rounded-2xl border bg-(--cn-surface) p-4">
              <h3 class="text-text-main text-sm font-bold">
                {m.carte_panel_heading()}
              </h3>
              {#if selectedBubble && selectedContent}
                <p class="text-text-main text-sm font-bold">
                  {selectedContent.name}
                </p>

                <div class="text-text-muted flex items-center gap-2 text-xs font-semibold">
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
                      class="text-text-muted hover:text-text-main underline"
                    >
                      {m.carte_panel_color_reset()}
                    </button>
                  {/if}
                </div>

                <div class="space-y-1.5">
                  <span class="text-text-muted block text-xs font-semibold"
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
                  <span class="text-text-muted block text-xs font-semibold"
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

                <div class="border-cn-border space-y-1.5 border-t pt-2">
                  <span class="text-text-muted block text-xs font-semibold"
                    >{m.carte_members_shown_label()}</span
                  >
                  <div class="space-y-1">
                    {#if selectedContent}
                      {@const defaultSelected = selectedContent.members
                        .filter((m) => m.isAdmin)
                        .slice(0, 7)
                        .map((m) => m.userId)}
                      {@const admins = selectedContent.members.filter((m) => m.isAdmin)}
                      {@const nonAdmins = selectedContent.members.filter((m) => !m.isAdmin)}

                      {#each admins as member (member.userId)}
                        {@const isSelected = selectedBubble.selectedBureau
                          ? selectedBubble.selectedBureau.includes(member.userId)
                          : defaultSelected.includes(member.userId)}
                        {@const maxReached =
                          (selectedBubble.selectedBureau || defaultSelected).length >= 7}
                        <label
                          class="text-text-main flex items-center gap-2 text-xs {maxReached &&
                          !isSelected
                            ? 'opacity-50'
                            : ''}"
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={maxReached && !isSelected}
                            onchange={(e) => {
                              let next = selectedBubble.selectedBureau
                                ? [...selectedBubble.selectedBureau]
                                : [...defaultSelected];
                              if (e.currentTarget.checked) {
                                if (!next.includes(member.userId)) next.push(member.userId);
                              } else {
                                next = next.filter((id) => id !== member.userId);
                              }
                              patchBubble(selectedBubble.assoId, {
                                selectedBureau: next,
                              });
                            }}
                            class="accent-cn-yellow"
                          />
                          {member.name}
                          {member.role ? `- ${member.role}` : ''}
                        </label>
                      {/each}

                      {#if nonAdmins.length > 0 && admins.length > 0}
                        <div class="border-cn-border my-1.5 border-t opacity-50"></div>
                      {/if}

                      {#each nonAdmins as member (member.userId)}
                        {@const isSelected = selectedBubble.selectedBureau
                          ? selectedBubble.selectedBureau.includes(member.userId)
                          : defaultSelected.includes(member.userId)}
                        {@const maxReached =
                          (selectedBubble.selectedBureau || defaultSelected).length >= 7}
                        <label
                          class="text-text-main flex items-center gap-2 text-xs {maxReached &&
                          !isSelected
                            ? 'opacity-50'
                            : ''}"
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={maxReached && !isSelected}
                            onchange={(e) => {
                              let next = selectedBubble.selectedBureau
                                ? [...selectedBubble.selectedBureau]
                                : [...defaultSelected];
                              if (e.currentTarget.checked) {
                                if (!next.includes(member.userId)) next.push(member.userId);
                              } else {
                                next = next.filter((id) => id !== member.userId);
                              }
                              patchBubble(selectedBubble.assoId, {
                                selectedBureau: next,
                              });
                            }}
                            class="accent-cn-yellow"
                          />
                          {member.name}
                          {member.role ? `- ${member.role}` : ''}
                        </label>
                      {/each}
                    {/if}
                  </div>
                </div>

                <div class="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    onclick={() => bringToFront(selectedBubble.assoId)}
                    class="border-cn-border text-text-muted hover:text-text-main inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold"
                  >
                    <BringToFront size={13} />
                    {m.carte_panel_front()}
                  </button>
                  <button
                    type="button"
                    onclick={() => sendToBack(selectedBubble.assoId)}
                    class="border-cn-border text-text-muted hover:text-text-main inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold"
                  >
                    <SendToBack size={13} />
                    {m.carte_panel_back()}
                  </button>
                  <button
                    type="button"
                    onclick={() => resetBubble(selectedBubble.assoId)}
                    class="border-cn-border text-text-muted hover:text-text-main inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold"
                  >
                    <RotateCcw size={13} />
                    {m.carte_panel_reset()}
                  </button>
                </div>
              {:else}
                <p class="text-text-muted text-xs">{m.carte_panel_empty()}</p>
              {/if}
            </section>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}
