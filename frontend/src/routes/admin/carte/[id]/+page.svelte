<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import { resolve } from '$app/paths';
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
    listMembers,
    listCarteSpaces,
    setPosterEntries,
    createPosterZone,
    renamePosterZone,
    deletePosterZone,
    reorderPosterZones,
    CARTE_REFUSAL,
    type Association,
    type CarteSpace,
    type PosterEntry,
    type PosterProject,
    type PosterZone,
    type AssociationMember,
  } from '$lib/associations/api';
  import { classifyMapAssociations, parkedPlacements } from '$lib/carte/mapEntries';
  import { carteSpaceLabel } from '$lib/carte/spaceLabel';
  import { refusalCode } from '$lib/utils/apiRefusal';
  import FloatingSurface from '$lib/components/ui/FloatingSurface.svelte';
  import MenuList from '$lib/components/ui/MenuList.svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import { opensAsSheet } from '$lib/components/ui/floatingSurface';
  import type { MenuListSection } from '$lib/components/ui/menuList';
  import Picker from '$lib/components/ui/Picker.svelte';
  import type { PickerOption } from '$lib/components/ui/picker';
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
    STAGE_WIDTH,
    TEXT_BASE_WIDTH,
    directoryRect,
    type PositionedBubble,
    type Decoration,
  } from '$lib/carte/layout';
  import { CARTE_SHAPES, shapeRadius, LOGO_SHAPES, logoShape } from '$lib/carte/shapes';
  import { exportPosterPdf } from '$lib/carte/export';
  import {
    CARTE_DRAG_MIME,
    decodeDrag,
    encodeDrag,
    groupAssociationsByZone,
    moveZoneId,
    planAssociationDrop,
    planZoneReorder,
    type CarteDrag,
  } from '$lib/carte/editorDnd';
  import { barPublishAction, overflowActions, type OverflowAction } from '$lib/carte/publishAction';
  import { buildPublishedCarte, fingerprintPublishedCarte } from '$lib/carte/publish';
  import PosterCanvas from '$lib/components/carte/PosterCanvas.svelte';
  import { MonitorSmartphone } from '@lucide/svelte';
  import { isCoarsePointerDevice, onCoarsePointerChange } from '$lib/utils/pointerDevice';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { exactDate } from '$lib/utils/time';
  import { createSerialSaver, layoutFingerprint } from '$lib/carte/editorPersistence';
  import ColorPicker from '$lib/components/ui/ColorPicker.svelte';
  import {
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
    ArrowLeft,
    Ellipsis,
    Map as MapIcon,
    Users,
    GripVertical,
    PanelRightClose,
    PanelRightOpen,
    ZoomIn,
    ZoomOut,
    Pencil,
    Globe,
    GlobeLock,
    TriangleAlert,
    RefreshCw,
    Sparkles,
    Plus,
    ChevronUp,
    ChevronDown,
    Search,
  } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { portalWhile } from '$lib/actions/portal';
  import { coversScreen } from '$lib/actions/coversScreen.svelte';

  let ready = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let project = $state<PosterProject | null>(null);
  let model = $state<PosterModel | null>(null);

  // -- The map's space, zones and switches (owner, 2026-11-08) --
  /** The space the map is drawn for; null for a map migration 147 could not attach. */
  let space = $state<CarteSpace | null>(null);
  /** The map's own zones, in order. */
  let zones = $state<PosterZone[]>([]);
  /** The switch of every association the map has seen. */
  let entries = $state<PosterEntry[]>([]);
  /** Every association the map's space offers today; one with no entry is new. */
  let spaceAssociationIds = $state<string[]>([]);
  /** Live data of the space's associations, and their rosters, re-read on every open. */
  let spaceAssociations = $state<Association[]>([]);
  let membersByAsso = $state<Record<string, AssociationMember[]>>({});
  /** Saved placements of associations not drawn now (off, or no longer of the space): kept, never dropped. */
  let parked = $state<PositionedBubble[]>([]);
  const classified = $derived(classifyMapAssociations(spaceAssociationIds, entries));
  /** Association ids whose switch write is in flight. */
  let busyEntries = $state<string[]>([]);
  /**
   * Bumped by a refused switch or zone write. The switch flipped itself on the click and its prop
   * did not change, so only re-drawing the rows puts it back on what the map stores.
   */
  let entryRefusals = $state(0);
  let assoSearch = $state('');
  /** The spaces an unattached map may be attached to (the platform admin's). */
  let attachSpaces = $state<CarteSpace[]>([]);
  let attachSpaceId = $state('');
  /** Whether the secondary alerts (memberless, overlaps) are unfolded. */
  let alertsOpen = $state(false);

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
      // The parked placements travel too: switching an association off never deletes its placement.
      bubbles: [...positioned, ...parked],
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
      bubbles: [...positioned, ...parked],
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

  // ── The canvas fills the window (owner, 2026-11-11) ───────────────────────────────────────
  /** Which half of the poster the canvas shows: the whole map, or the directory column alone. */
  let view = $state<'map' | 'directory'>('map');
  /** The scroll area's size, from which the fit scale is derived. */
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);
  let viewportEl = $state<HTMLElement>();
  /** The un-scaled poster node: what the PDF export captures. */
  let posterEl = $state<HTMLElement>();
  /** Room kept around the poster inside the scroll area (px). */
  const CANVAS_PAD = 24;
  /** User zoom multiplier on top of the fit scale (1 = fit; >1 scrolls). */
  let zoom = $state(1);
  const MIN_ZOOM = 0.4;
  const MAX_ZOOM = 4;
  const dirBox = directoryRect();
  /** Scale that fits what the current view shows into the window. */
  const fitScale = $derived.by(() => {
    if (viewportWidth <= 0 || viewportHeight <= 0) return 1;
    const room = { w: viewportWidth - 2 * CANVAS_PAD, h: viewportHeight - 2 * CANVAS_PAD };
    const box = view === 'directory' ? dirBox : { w: STAGE_WIDTH, h: STAGE_HEIGHT };
    return Math.max(0.05, Math.min(2, room.w / box.w, room.h / box.h));
  });
  /** Effective on-screen scale (fit * zoom); drives the poster transform + pointer math. */
  const viewScale = $derived(fitScale * zoom);

  function zoomBy(delta: number) {
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round((zoom + delta) * 100) / 100));
  }

  /** Switches the canvas between the map and the directory, then frames what it now shows. */
  async function selectView(next: 'map' | 'directory'): Promise<void> {
    Log.d('admin.carte.id.selectView', { from: view, to: next });
    view = next;
    zoom = 1;
    await tick();
    if (!viewportEl) return;
    if (next === 'directory') {
      viewportEl.scrollLeft = (dirBox.x + dirBox.w / 2) * viewScale - viewportWidth / 2;
      viewportEl.scrollTop = (dirBox.y + dirBox.h / 2) * viewScale - viewportHeight / 2;
    } else {
      viewportEl.scrollLeft = 0;
      viewportEl.scrollTop = 0;
    }
  }

  /** The side panel is folded away to give the canvas its whole width. */
  let panelOpen = $state(true);

  /**
   * Rebuilds the drawn model from the switches and zones, keeping every placement: those of the
   * associations drawn now are merged, the others parked (see {@link parkedPlacements}).
   */
  function rebuildModel(): void {
    const shown = spaceAssociations.filter((a) => classified.on.has(a.id));
    const built = buildPosterModel(
      shown,
      zones,
      classified.zoneOf,
      membersByAsso,
      m.carte_zone_uncategorized()
    );
    const known = [...positioned, ...parked];
    positioned = mergeBubbleLayout(known, built);
    parked = parkedPlacements(known, new Set(shown.map((a) => a.id)));
    model = built;
  }

  async function loadData() {
    loading = true;
    error = null;
    try {
      const [proj, associations] = await Promise.all([
        getPosterProject(projectId),
        listAssociations('association'),
      ]);
      project = proj;
      space = proj.space;
      zones = proj.zones;
      entries = proj.entries;
      spaceAssociationIds = proj.spaceAssociationIds;
      const ofSpace = new Set(proj.spaceAssociationIds);
      spaceAssociations = associations.filter((a) => ofSpace.has(a.id));
      Log.d('admin.carte.id.loadData', {
        projectId,
        space: proj.space?.id ?? null,
        offered: proj.spaceAssociationIds.length,
        listed: spaceAssociations.length,
      });

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

      // Rosters of the space's associations only (president detection, directory). A failed
      // roster is logged and drawn empty - the editor names memberless associations anyway.
      const rosters = await Promise.all(
        spaceAssociations.map((a) =>
          listMembers(a.id).catch((e: unknown) => {
            Log.d('admin.carte.id.loadData roster failed', { assoId: a.id, e });
            return [] as AssociationMember[];
          })
        )
      );
      const byAsso: Record<string, AssociationMember[]> = {};
      spaceAssociations.forEach((a, i) => (byAsso[a.id] = rosters[i]));
      membersByAsso = byAsso;

      // Reconcile saved positions with the live model (adds switched-on assos, parks the rest).
      positioned = [];
      parked = Array.isArray(layout.bubbles) ? (layout.bubbles as PositionedBubble[]) : [];
      rebuildModel();
      // What was just loaded IS what the server holds, so the editor opens with nothing to save.
      // A flag armed here instead would make opening a project write it back - every open rewrote
      // the layout 4 s later, and a new association was reseeded with a RANDOM shape on the way.
      savedFingerprint = fingerprint;
      // What the LIVE map is, as the server recorded it at its publish. `undefined` from a server
      // that predates the column reads the same as null: unknown.
      liveFingerprint = project?.publicationFingerprint ?? null;
      if (!proj.space) {
        attachSpaces = await listCarteSpaces();
      }
    } catch (e) {
      Log.d('admin.carte.id.loadData failed', e);
      error = m.common_load_error();
    } finally {
      loading = false;
    }
  }

  // -- Switches and zones (stored in the project, written at once) --
  /** Merges the rows the server wrote into the local switches. */
  function mergeEntries(written: PosterEntry[]): void {
    const rewritten = new Set(written.map((row) => row.associationId));
    entries = [...entries.filter((e) => !rewritten.has(e.associationId)), ...written];
  }

  /** Writes switches and/or zones, then redraws; an error is shown and the state left as it was. */
  async function writeEntries(
    rows: { associationId: string; enabled?: boolean; zoneId?: string | null }[]
  ): Promise<void> {
    if (!project || rows.length === 0) return;
    const ids = rows.map((r) => r.associationId);
    busyEntries = [...busyEntries, ...ids];
    error = null;
    try {
      mergeEntries(await setPosterEntries(project.id, rows));
      rebuildModel();
      void refreshPublishFingerprint();
      Log.d('admin.carte.id.writeEntries', { count: rows.length });
    } catch (e) {
      Log.d('admin.carte.id.writeEntries failed', e);
      error = m.common_save_error();
      entryRefusals++;
    } finally {
      busyEntries = busyEntries.filter((id) => !ids.includes(id));
    }
  }

  /** "Leave them off": every new association becomes seen, switched off. */
  function dismissNewAssociations(): Promise<void> {
    return writeEntries(
      [...classified.fresh].map((associationId) => ({ associationId, enabled: false }))
    );
  }

  /** The panel's rows: filtered by the search, grouped by zone (the no-zone group first). */
  const zoneGroups = $derived(
    groupAssociationsByZone(
      spaceAssociations.filter((a) => {
        const q = assoSearch.trim().toLocaleLowerCase();
        return !q || a.name.toLocaleLowerCase().includes(q);
      }),
      zones.map((z) => z.id),
      classified.zoneOf,
      classified.fresh
    )
  );
  const zoneOptions = $derived<PickerOption[]>([
    { value: '', label: m.carte_zone_uncategorized() },
    ...zones.map((z) => ({ value: z.id, label: z.label })),
  ]);
  const freshNames = $derived(
    spaceAssociations.filter((a) => classified.fresh.has(a.id)).map((a) => a.name)
  );

  let newZoneLabel = $state('');
  let zoneBusy = $state(false);
  /** Bumped by a refused zone write: re-draws the inputs from the stored zones. */
  let zoneRefusals = $state(0);

  /** Runs one zone write, then redraws the directory groups. */
  async function zoneWrite(label: string, run: () => Promise<void>): Promise<void> {
    if (!project || zoneBusy) return;
    zoneBusy = true;
    error = null;
    try {
      await run();
      rebuildModel();
      void refreshPublishFingerprint();
      Log.d(`admin.carte.id.${label}`, { zones: zones.length });
    } catch (e) {
      Log.d(`admin.carte.id.${label} failed`, e);
      error = m.common_save_error();
      zoneRefusals++;
    } finally {
      zoneBusy = false;
    }
  }

  function addZone(): Promise<void> {
    const label = newZoneLabel.trim();
    if (!label || !project) return Promise.resolve();
    const id = project.id;
    return zoneWrite('addZone', async () => {
      zones = [...zones, await createPosterZone(id, label)];
      newZoneLabel = '';
    });
  }

  function renameZone(zone: PosterZone, label: string): Promise<void> {
    const trimmed = label.trim();
    if (!trimmed || trimmed === zone.label || !project) return Promise.resolve();
    const id = project.id;
    return zoneWrite('renameZone', async () => {
      const updated = await renamePosterZone(id, zone.id, trimmed);
      zones = zones.map((z) => (z.id === zone.id ? updated : z));
    });
  }

  async function deleteZone(zone: PosterZone): Promise<void> {
    if (!project) return;
    const confirmed = await showConfirm(m.carte_zone_delete_confirm({ label: zone.label }), {
      danger: true,
      confirmLabel: m.common_remove_label(),
    });
    if (!confirmed) return;
    const id = project.id;
    await zoneWrite('deleteZone', async () => {
      await deletePosterZone(id, zone.id);
      zones = zones.filter((z) => z.id !== zone.id);
      entries = entries.map((e) => (e.zoneId === zone.id ? { ...e, zoneId: null } : e));
    });
  }

  /** Writes a new zone order (a drop, or the keyboard twin of one). */
  function applyZoneOrder(ids: string[] | null): Promise<void> {
    if (!ids || !project) return Promise.resolve();
    const id = project.id;
    return zoneWrite('reorderZones', async () => {
      zones = await reorderPosterZones(id, ids);
    });
  }

  /** Keyboard path of the zone drag: Up and Down on a zone's grip move it one step. */
  function onZoneGripKey(e: KeyboardEvent, zone: PosterZone): void {
    const delta = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    void applyZoneOrder(
      moveZoneId(
        zones.map((z) => z.id),
        zone.id,
        delta
      )
    );
  }

  // -- Drag and drop in the panel: an association onto a zone, a zone onto a zone --
  /** What is being dragged now (`dataTransfer` cannot be read while hovering, only on the drop). */
  let dragging = $state<CarteDrag | null>(null);
  /** The zone group under the pointer (`''` = the no-zone group), for the drop highlight. */
  let dropTarget = $state<string | null>(null);

  function startDrag(e: DragEvent, drag: CarteDrag): void {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(CARTE_DRAG_MIME, encodeDrag(drag));
    e.dataTransfer.effectAllowed = 'move';
    dragging = drag;
    Log.d('admin.carte.id.startDrag', drag);
  }

  function endDrag(): void {
    dragging = null;
    dropTarget = null;
  }

  /** Whether the current drag may land on this zone group (an association on any, a zone on a zone). */
  function acceptsDrop(zoneId: string | null): boolean {
    if (!dragging) return false;
    return dragging.kind === 'asso' || zoneId !== null;
  }

  function overZone(e: DragEvent, zoneId: string | null): void {
    if (!acceptsDrop(zoneId)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dropTarget = zoneId ?? '';
  }

  function dropOnZone(e: DragEvent, zoneId: string | null): void {
    e.preventDefault();
    const drag = decodeDrag(e.dataTransfer?.getData(CARTE_DRAG_MIME)) ?? dragging;
    endDrag();
    const assignment = planAssociationDrop(drag, zoneId, classified.zoneOf);
    if (assignment) {
      Log.d('admin.carte.id.dropAssociation', assignment);
      void writeEntries([assignment]);
      return;
    }
    if (zoneId === null) return;
    const order = planZoneReorder(
      zones.map((z) => z.id),
      drag,
      zoneId
    );
    Log.d('admin.carte.id.dropZone', { zoneId, moved: order !== null });
    void applyZoneOrder(order);
  }

  /** Attaches a map left without a space by migration 147, then reopens it. */
  async function attachToSpace(): Promise<void> {
    if (!project || !attachSpaceId) return;
    error = null;
    try {
      await updatePosterProject(project.id, { spaceId: attachSpaceId });
      Log.d('admin.carte.id.attachToSpace', { projectId: project.id, spaceId: attachSpaceId });
      await loadData();
    } catch (e) {
      Log.d('admin.carte.id.attachToSpace failed', e);
      error = m.common_save_error();
    }
  }
  const attachOptions = $derived<PickerOption[]>(
    attachSpaces.map((sp) => ({ value: sp.id, label: carteSpaceLabel(sp) }))
  );

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
      const code = refusalCode(e);
      error =
        code === CARTE_REFUSAL.UNIT_OUTSIDE_MAP
          ? m.carte_publish_refused_outside()
          : code === CARTE_REFUSAL.NOT_ATTACHED
            ? m.carte_publish_refused_unattached()
            : m.common_save_error();
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

  const publicationFacts = $derived({
    isPublished,
    liveFingerprint,
    savedFingerprint: savedFingerprintValue,
  });
  const barAction = $derived(barPublishAction(publicationFacts));

  // The "..." menu: the rare actions, out of the bar's way (owner, 2026-11-11).
  let menuOpen = $state(false);
  let menuAsSheet = $state(false);
  let menuAnchor = $state<HTMLElement | null>(null);
  const menuSections = $derived<MenuListSection[]>([
    {
      items: overflowActions(publicationFacts).map((action) => {
        switch (action) {
          case 'update':
            return { key: action, label: m.carte_publish_update_button(), Icon: RefreshCw };
          case 'unpublish':
            return { key: action, label: m.carte_unpublish_button(), Icon: GlobeLock };
          case 'export':
            return { key: action, label: m.carte_export_button(), Icon: Download };
        }
      }),
    },
  ]);

  function toggleMenu(): void {
    if (menuOpen) {
      menuOpen = false;
      return;
    }
    menuAsSheet = opensAsSheet();
    menuOpen = true;
  }

  function pickMenuAction(key: string): void {
    menuOpen = false;
    Log.d('admin.carte.id.menu', { action: key });
    const action = key as OverflowAction;
    if (action === 'update') void handlePublish();
    else if (action === 'unpublish') void handleUnpublish();
    else void handleExport();
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
      void goto(resolve('/admin'), { replace: true });
      return;
    }
    ready = true;
    void loadData();
  });
</script>

{#if ready}
  <!-- THE EDITOR LEAVES THE ADMIN FRAME (owner, 2026-11-11: "ca ne prend qu'une petite partie de
       l'ecran"). It is portalled to the body at `--z-page-overlay` - the rung the old "full page"
       mode used, and the reason it is a portal: `.page-scroll-wrap` is a containing block, so a
       `fixed inset-0` left inside it would cover the scrolled wrapper, not the window. Toasts,
       sheets and the confirm dialog stay above it. -->
  <div
    use:portalWhile={true}
    use:coversScreen
    class="bg-cn-bg text-text-main fixed inset-0 z-(--z-page-overlay) flex flex-col pt-(--safe-area-inset-top,0px)"
  >
    {#if loading}
      <div class="flex flex-1 items-center justify-center">
        <div
          class="border-accent-icon h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
        ></div>
      </div>
    {:else if error && !project}
      <div class="flex flex-1 flex-col items-center justify-center gap-3">
        <p class="text-sm text-red-500" role="alert">{error}</p>
        <Button variant="secondary" size="compact" href={resolve('/admin/carte')}>
          <ArrowLeft size={16} />
          {m.carte_back_to_list()}
        </Button>
      </div>
    {:else if project && model}
      <!-- ONE top bar: where I am, the state of my work, the one action that matters, and "..." for
           the rest. It scrolls sideways on a narrow window rather than wrapping. -->
      <header
        class="border-cn-border bg-cn-surface flex shrink-0 items-center gap-2 overflow-x-auto border-b px-3 py-2 whitespace-nowrap"
      >
        <Button
          variant="ghost"
          size="compact"
          icon
          href={resolve('/admin/carte')}
          aria-label={m.carte_back_to_list()}
          title={m.carte_back_to_list()}
        >
          <ArrowLeft size={18} />
        </Button>
        {#if !canEdit}
          <h2 class="font-display text-text-main text-lg font-bold">{project.name}</h2>
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
            class="text-text-main border-accent-icon border-b-2 bg-transparent px-0 py-0 text-lg font-bold outline-none"
            style="min-width:120px;max-width:400px;width:{Math.max(120, editedName.length * 10)}px;"
          />
        {:else}
          <Button
            variant="ghost"
            size="compact"
            class="group"
            onclick={startRenamingName}
            title={m.admin_carte_rename_project_title()}
          >
            <span class="text-text-main text-base font-bold">{project.name}</span>
            <Pencil size={14} class="opacity-0 transition-opacity group-hover:opacity-60" />
          </Button>
        {/if}
        {#if space}
          <span
            class="border-cn-border text-text-muted shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold"
          >
            {carteSpaceLabel(space)}
          </span>
        {/if}

        {#if canEdit}
          <SegmentedControl
            class="mx-2 w-48 shrink-0"
            label={m.carte_view_label()}
            value={view}
            items={[
              { key: 'map', label: m.carte_tab_map() },
              { key: 'directory', label: m.carte_tab_directory() },
            ]}
            onSelect={(key) => void selectView(key)}
          />
        {/if}

        <div class="ml-auto flex shrink-0 items-center gap-2">
          {#if canEdit}
            <!-- The save state is a STATUS, not a button's label. -->
            <span
              class="text-text-muted inline-flex items-center gap-1.5 text-xs"
              aria-live="polite"
            >
              {#if saving}
                {m.carte_saving_label()}
              {:else if saved}
                <Check size={14} class="text-green-600" />
                {m.carte_saved_label()}
              {:else if unsavedChanges}
                {m.carte_unsaved_label()}
              {/if}
            </span>
          {/if}
          <!-- BEING LIVE IS A STATE, NOT A BUTTON. The chip only reports. -->
          {#if isPublished}
            <span
              class="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-green-600/40 bg-green-600/10 px-2.5 py-1 text-xs font-bold text-green-700 dark:text-green-400"
            >
              <Globe size={13} />
              {m.carte_published_since({ date: publishedOn })}
            </span>
          {/if}
          <!-- The live map is older than what is saved (or cannot be compared): one click puts the
               saved version online. Nothing republishes on its own: an autosave that reached the
               portail would put half-arranged layouts online (D2). -->
          {#if barAction === 'update'}
            <Button
              size="compact"
              onclick={handlePublish}
              disabled={publishing}
              title={m.carte_publish_update_hint()}
            >
              <RefreshCw size={16} />
              {publishing ? m.carte_publishing_label() : m.carte_publish_update_button()}
            </Button>
          {:else if barAction === 'publish'}
            <Button
              variant="secondary"
              size="compact"
              onclick={handlePublish}
              disabled={publishing || !space}
              title={m.carte_publish_hint()}
            >
              <Globe size={16} />
              {publishing ? m.carte_publishing_label() : m.carte_publish_button()}
            </Button>
          {/if}
          {#if canEdit}
            <Button
              variant={unsavedChanges ? 'primary' : 'secondary'}
              size="compact"
              onclick={handleSave}
              disabled={saving}
            >
              <Save size={16} />
              {m.carte_save_button()}
            </Button>
          {/if}
          <span bind:this={menuAnchor} class="inline-flex shrink-0">
            <Button
              variant="ghost"
              size="compact"
              icon
              onclick={toggleMenu}
              aria-label={m.carte_more_actions()}
              title={m.carte_more_actions()}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <Ellipsis size={18} />
            </Button>
          </span>
          {#if canEdit}
            <Button
              variant="ghost"
              size="compact"
              icon
              onclick={() => (panelOpen = !panelOpen)}
              aria-label={panelOpen ? m.carte_panel_collapse() : m.carte_panel_expand()}
              title={panelOpen ? m.carte_panel_collapse() : m.carte_panel_expand()}
              aria-expanded={panelOpen}
            >
              {#if panelOpen}<PanelRightClose size={18} />{:else}<PanelRightOpen size={18} />{/if}
            </Button>
          {/if}
        </div>
      </header>

      <FloatingSurface
        open={menuOpen}
        asSheet={menuAsSheet}
        anchor={menuAnchor}
        label={m.carte_more_actions()}
        popoverWidth="content"
        onClose={(refocus) => {
          menuOpen = false;
          if (refocus) menuAnchor?.querySelector('button')?.focus();
        }}
      >
        <div class="min-w-56">
          <MenuList
            sections={menuSections}
            label={m.carte_more_actions()}
            onSelect={pickMenuAction}
          />
        </div>
      </FloatingSurface>

      <div class="flex min-h-0 flex-1">
        <!-- THE CANVAS: it takes every pixel the panel leaves. -->
        <div class="relative flex min-w-0 flex-1 flex-col">
          {#if error}
            <p class="shrink-0 px-4 pt-2 text-sm text-red-500" role="alert">{error}</p>
          {/if}

          <!-- A background tab throttles the animation frames the capture runs on, and an export
               that took minutes looked like a hung button. Say so while it runs. -->
          {#if exporting}
            <p class="text-text-muted shrink-0 px-4 pt-2 text-sm">
              {m.carte_export_foreground_hint()}
            </p>
          {/if}

          {#if !space}
            <div
              class="border-cn-border bg-cn-surface-alt m-3 flex shrink-0 flex-wrap items-center gap-3 rounded-2xl border p-3"
            >
              <TriangleAlert size={18} class="text-accent-icon shrink-0" />
              <div class="min-w-0 flex-1">
                <p class="text-text-main text-sm font-bold">{m.carte_unattached_title()}</p>
                <p class="text-text-muted mt-0.5 text-sm">{m.carte_unattached_body()}</p>
              </div>
              {#if attachOptions.length > 0}
                <Picker
                  value={attachSpaceId}
                  options={attachOptions}
                  onValueChange={(v) => (attachSpaceId = v)}
                  label={m.carte_space_pick()}
                  placeholder={m.carte_space_pick()}
                  variant="field"
                />
                <Button size="compact" onclick={attachToSpace} disabled={!attachSpaceId}>
                  {m.carte_attach_button()}
                </Button>
              {/if}
            </div>
          {/if}

          {#if !canEdit}
            <div
              class="border-cn-border bg-cn-surface-alt m-3 flex shrink-0 items-start gap-3 rounded-2xl border p-3"
            >
              <MonitorSmartphone size={18} class="text-text-muted mt-0.5 shrink-0" />
              <div>
                <p class="text-text-main text-sm font-bold">{m.carte_desktop_only_title()}</p>
                <p class="text-text-muted mt-0.5 text-sm">{m.carte_desktop_only_body()}</p>
              </div>
            </div>
          {/if}

          <!-- Scroll area. The un-scaled inner element is the exact node captured for the PDF; the
               directory tab only scrolls and scales this same poster to the directory column. -->
          <div
            bind:this={viewportEl}
            bind:clientWidth={viewportWidth}
            bind:clientHeight={viewportHeight}
            class="min-h-0 flex-1 overflow-auto"
          >
            <div class="flex min-h-full w-max min-w-full" style:padding="{CANVAS_PAD}px">
              <div
                class="m-auto shrink-0 shadow-lg"
                style:width="{STAGE_WIDTH * viewScale}px"
                style:height="{STAGE_HEIGHT * viewScale}px"
              >
                <div
                  style:transform="scale({viewScale})"
                  style:transform-origin="top left"
                  style:width="{STAGE_WIDTH}px"
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

          {#if view === 'directory' && !directoryVisible}
            <div
              class="border-cn-border bg-cn-surface absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 rounded-2xl border p-4 text-center shadow-lg"
            >
              <p class="text-text-main text-sm font-bold">{m.carte_directory_hidden_title()}</p>
              <p class="text-text-muted text-sm">{m.carte_directory_hidden_body()}</p>
              <Button size="compact" onclick={() => (directoryVisible = true)}>
                {m.carte_directory_show()}
              </Button>
            </div>
          {/if}

          <!-- Zoom: floats over the canvas corner instead of taking a row of its own. -->
          <div
            class="border-cn-border bg-cn-surface absolute bottom-3 left-3 flex items-center gap-1 rounded-full border p-1 shadow-md"
          >
            <Button
              variant="ghost"
              size="compact"
              icon
              onclick={() => zoomBy(-0.25)}
              aria-label={m.carte_zoom_out()}
            >
              <ZoomOut size={15} />
            </Button>
            <Button variant="ghost" size="compact" class="min-w-14" onclick={() => (zoom = 1)}>
              {Math.round(zoom * 100)}%
            </Button>
            <Button
              variant="ghost"
              size="compact"
              icon
              onclick={() => zoomBy(0.25)}
              aria-label={m.carte_zoom_in()}
            >
              <ZoomIn size={15} />
            </Button>
          </div>
        </div>

        <!-- THE SIDE PANEL: collapsible. Every control in it writes the layout, so it is absent
             rather than disabled where editing is not offered. -->
        {#if canEdit && panelOpen}
          <aside
            class="border-cn-border bg-cn-surface w-88 shrink-0 divide-y divide-(--cn-border) overflow-y-auto border-l"
          >
            {#if selectedDecoration}
              <!-- Selected-decoration property panel -->
              <section class="space-y-3 p-3">
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
                        class="accent-accent"
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
                          ? 'border-accent-icon bg-accent/15 text-cn-dark'
                          : 'border-cn-border text-text-muted hover:text-text-main'}"
                      >
                        <opt.icon size={14} />
                      </button>
                    {/each}
                  </div>
                {/if}

                <div class="flex flex-wrap gap-2 pt-1">
                  <Button
                    variant="secondary"
                    size="compact"
                    onclick={() => decoBringToFront(selectedDecoration.id)}
                  >
                    <BringToFront size={13} />
                    {m.carte_panel_front()}
                  </Button>
                  <Button
                    variant="secondary"
                    size="compact"
                    onclick={() => decoSendToBack(selectedDecoration.id)}
                  >
                    <SendToBack size={13} />
                    {m.carte_panel_back()}
                  </Button>
                  <Button
                    variant="danger-outline"
                    size="compact"
                    onclick={() => deleteDecoration(selectedDecoration.id)}
                  >
                    <Trash2 size={13} />
                    {m.carte_deco_delete()}
                  </Button>
                </div>
              </section>
            {/if}
            <!-- Selected-bubble property panel -->
            <section class="space-y-3 p-3">
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
                          ? 'border-accent-icon text-accent-text'
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
                          ? 'border-accent-icon text-accent-text'
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
                            class="accent-accent"
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
                            class="accent-accent"
                          />
                          {member.name}
                          {member.role ? `- ${member.role}` : ''}
                        </label>
                      {/each}
                    {/if}
                  </div>
                </div>

                <div class="flex flex-wrap gap-2 pt-1">
                  <Button
                    variant="secondary"
                    size="compact"
                    onclick={() => bringToFront(selectedBubble.assoId)}
                  >
                    <BringToFront size={13} />
                    {m.carte_panel_front()}
                  </Button>
                  <Button
                    variant="secondary"
                    size="compact"
                    onclick={() => sendToBack(selectedBubble.assoId)}
                  >
                    <SendToBack size={13} />
                    {m.carte_panel_back()}
                  </Button>
                  <Button
                    variant="secondary"
                    size="compact"
                    onclick={() => resetBubble(selectedBubble.assoId)}
                  >
                    <RotateCcw size={13} />
                    {m.carte_panel_reset()}
                  </Button>
                </div>
              {:else}
                <p class="text-text-muted text-xs">{m.carte_panel_empty()}</p>
              {/if}
            </section>

            <!-- New associations of the space: switched off until the author decides (owner, 2026-11-08). -->
            {#if freshNames.length > 0}
              <div class="bg-accent/10 flex items-start gap-2 p-3">
                <Sparkles size={16} class="text-cn-dark mt-0.5 shrink-0" />
                <div class="min-w-0 flex-1">
                  <p class="text-text-main text-sm font-bold">
                    {m.carte_new_assos_title({ count: freshNames.length })}
                  </p>
                  <p class="text-text-muted mt-0.5 text-xs">{m.carte_new_assos_body()}</p>
                  <p class="text-text-muted mt-1 text-xs">{freshNames.join(' - ')}</p>
                </div>
                <Button variant="secondary" size="compact" onclick={dismissNewAssociations}>
                  {m.carte_new_assos_dismiss()}
                </Button>
              </div>
            {/if}

            {#if space}
              <!-- Associations and zones in ONE list: a zone is a header the rows hang under. A row
                   is dragged onto a zone to file it there, a zone header is dragged to reorder
                   (owner, 2026-11-11); the picker and the grip's arrow keys are the keyboard path. -->
              <section class="space-y-2 p-3">
                <div class="flex items-center justify-between gap-2">
                  <h3 class="text-text-main text-sm font-bold">{m.carte_assos_heading()}</h3>
                  <span class="text-text-muted text-xs"
                    >{classified.on.size}/{spaceAssociations.length}</span
                  >
                </div>
                <div class="flex items-center gap-2">
                  <Search size={14} class="text-text-muted shrink-0" />
                  <Input
                    bind:value={assoSearch}
                    type="search"
                    placeholder={m.carte_assos_search()}
                    aria-label={m.carte_assos_search()}
                    density="compact"
                    class="min-w-0 flex-1"
                  />
                </div>
                {#if spaceAssociations.length === 0}
                  <p class="text-text-muted text-xs">{m.carte_assos_empty()}</p>
                {:else}
                  <p class="text-text-muted text-xs">{m.carte_assos_drag_hint()}</p>
                  <!-- Re-keyed on a refused write: a switch or a label the server did not take is
                       drawn from what the map stores again. -->
                  {#key `${entryRefusals}-${zoneRefusals}`}
                    <div class="space-y-1">
                      {#each zoneGroups as group (group.zoneId ?? '')}
                        {@const zone = zones.find((z) => z.id === group.zoneId)}
                        {#if zone || group.zoneId === null}
                          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                          <div
                            role="group"
                            aria-label={zone ? zone.label : m.carte_zone_uncategorized()}
                            class="rounded-lg py-0.5 transition-colors {dropTarget ===
                            (group.zoneId ?? '')
                              ? 'bg-accent/15 ring-accent/60 ring-2'
                              : ''}"
                            ondragover={(e) => overZone(e, group.zoneId)}
                            ondragleave={() => {
                              if (dropTarget === (group.zoneId ?? '')) dropTarget = null;
                            }}
                            ondrop={(e) => dropOnZone(e, group.zoneId)}
                          >
                            {#if zone}
                              <div data-zone-head class="flex items-center gap-1 px-0.5">
                                <Button
                                  variant="ghost"
                                  size="compact"
                                  icon
                                  class="cursor-grab"
                                  draggable="true"
                                  disabled={zoneBusy}
                                  aria-label={m.carte_zone_drag({ label: zone.label })}
                                  title={m.carte_zone_drag({ label: zone.label })}
                                  ondragstart={(e: DragEvent) => {
                                    const head = (e.currentTarget as HTMLElement).closest(
                                      '[data-zone-head]'
                                    );
                                    if (head) e.dataTransfer?.setDragImage(head, 12, 12);
                                    startDrag(e, { kind: 'zone', id: zone.id });
                                  }}
                                  ondragend={endDrag}
                                  onkeydown={(e: KeyboardEvent) => onZoneGripKey(e, zone)}
                                >
                                  <GripVertical size={14} />
                                </Button>
                                <Input
                                  value={zone.label}
                                  maxlength={120}
                                  aria-label={m.carte_zone_rename({ label: zone.label })}
                                  onblur={(e: FocusEvent & { currentTarget: HTMLInputElement }) =>
                                    void renameZone(zone, e.currentTarget.value)}
                                  disabled={zoneBusy}
                                  density="compact"
                                  class="min-w-0 flex-1 font-bold"
                                />
                                <span class="text-text-muted shrink-0 text-xs">
                                  {group.items.filter((a) => classified.on.has(a.id)).length}/{group
                                    .items.length}
                                </span>
                                <Button
                                  variant="ghost"
                                  size="compact"
                                  icon
                                  onclick={() => void deleteZone(zone)}
                                  disabled={zoneBusy}
                                  aria-label={m.common_remove_label()}
                                  title={m.common_remove_label()}
                                >
                                  <Trash2 size={13} />
                                </Button>
                              </div>
                            {:else if zones.length > 0}
                              <p class="text-text-muted px-2 py-1 text-xs font-bold">
                                {m.carte_zone_uncategorized()}
                              </p>
                            {/if}
                            {#each group.items as asso (asso.id)}
                              <div
                                draggable="true"
                                role="listitem"
                                ondragstart={(e) => startDrag(e, { kind: 'asso', id: asso.id })}
                                ondragend={endDrag}
                                class="hover:bg-cn-bg flex cursor-grab items-center gap-2 rounded-md px-2 py-1 {classified.on.has(
                                  asso.id
                                )
                                  ? ''
                                  : 'opacity-60'}"
                              >
                                <input
                                  type="checkbox"
                                  checked={classified.on.has(asso.id)}
                                  disabled={busyEntries.includes(asso.id)}
                                  aria-label={m.carte_asso_shown({ name: asso.name })}
                                  onchange={(e) =>
                                    void writeEntries([
                                      { associationId: asso.id, enabled: e.currentTarget.checked },
                                    ])}
                                  class="accent-accent size-4 shrink-0 cursor-pointer"
                                />
                                <span
                                  class="text-text-main min-w-0 flex-1 truncate text-sm"
                                  title={asso.name}
                                >
                                  {asso.name}
                                </span>
                                {#if classified.fresh.has(asso.id)}
                                  <span
                                    class="bg-accent text-on-accent shrink-0 rounded-full px-2 py-0.5 text-xs font-bold"
                                  >
                                    {m.carte_asso_new_badge()}
                                  </span>
                                {/if}
                                {#if zones.length > 0}
                                  <div class="w-28 min-w-0 shrink-0">
                                    <Picker
                                      value={classified.zoneOf[asso.id] ?? ''}
                                      options={zoneOptions}
                                      onValueChange={(v) =>
                                        void writeEntries([
                                          { associationId: asso.id, zoneId: v || null },
                                        ])}
                                      label={m.carte_asso_zone({ name: asso.name })}
                                    />
                                  </div>
                                {/if}
                              </div>
                            {:else}
                              {#if zone}
                                <p class="text-text-muted px-2 py-1 text-xs italic">
                                  {m.carte_zone_drop_here()}
                                </p>
                              {/if}
                            {/each}
                          </div>
                        {/if}
                      {/each}
                    </div>
                  {/key}
                {/if}
                <form
                  class="flex items-center gap-2 pt-1"
                  onsubmit={(e) => {
                    e.preventDefault();
                    void addZone();
                  }}
                >
                  <Input
                    bind:value={newZoneLabel}
                    maxlength={120}
                    placeholder={m.carte_zone_add_placeholder()}
                    aria-label={m.carte_zone_add_placeholder()}
                    density="compact"
                    class="min-w-0 flex-1"
                  />
                  <Button
                    type="submit"
                    variant="secondary"
                    size="compact"
                    disabled={zoneBusy || !newZoneLabel.trim()}
                  >
                    <Plus size={13} />
                    {m.carte_zone_add_button()}
                  </Button>
                </form>
              </section>
            {/if}

            {#if (memberlessNames.length > 0 ? 1 : 0) + (overlaps.length > 0 ? 1 : 0) > 0}
              <div class="space-y-2 p-3">
                <Button
                  variant="ghost"
                  size="compact"
                  onclick={() => (alertsOpen = !alertsOpen)}
                  aria-expanded={alertsOpen}
                >
                  <TriangleAlert size={14} />
                  {m.carte_alerts_toggle({
                    count: (memberlessNames.length > 0 ? 1 : 0) + (overlaps.length > 0 ? 1 : 0),
                  })}
                  {#if alertsOpen}<ChevronUp size={14} />{:else}<ChevronDown size={14} />{/if}
                </Button>
                {#if alertsOpen}
                  <!-- Associations whose roster is empty. They stay on the poster (D10) - this is
                       for their bureau to act on, and an empty blob otherwise looks like a broken
                       render. -->
                  {#if memberlessNames.length > 0}
                    <div class="flex items-start gap-2">
                      <TriangleAlert size={16} class="text-text-muted mt-0.5 shrink-0" />
                      <div class="min-w-0">
                        <p class="text-text-main text-sm font-bold">
                          {m.carte_no_members_title({ count: memberlessNames.length })}
                        </p>
                        <p class="text-text-muted mt-0.5 text-xs">{m.carte_no_members_body()}</p>
                        <p class="text-text-muted mt-1 text-xs">{memberlessNames.join(' - ')}</p>
                      </div>
                    </div>
                  {/if}

                  <!-- Units drawn over each other. Listed and outlined on demand; never moved (D7). -->
                  {#if overlaps.length > 0}
                    <div class="flex items-start gap-2">
                      <TriangleAlert size={16} class="text-accent-icon mt-0.5 shrink-0" />
                      <div class="min-w-0">
                        <p class="text-text-main text-sm font-bold">
                          {m.carte_overlaps_title({ count: overlaps.length })}
                        </p>
                        <p class="text-text-muted mt-0.5 text-xs">{m.carte_overlaps_body()}</p>
                        <ul class="text-text-muted mt-1 space-y-0.5 text-xs">
                          {#each overlaps as pair (pair.a + pair.b)}
                            <li>
                              {m.carte_overlaps_pair({ a: assoName(pair.a), b: assoName(pair.b) })}
                            </li>
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
                {/if}
              </div>
            {/if}

            <section class="space-y-3 p-3">
              <h3 class="text-text-main text-sm font-bold">{m.carte_settings_heading()}</h3>

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
                  <Button
                    variant="secondary"
                    size="compact"
                    onclick={() => {
                      bgDataUrl = null;
                      bgVersion++;
                    }}
                  >
                    <X size={15} />
                    {m.carte_background_clear()}
                  </Button>
                  <label class="text-text-muted inline-flex items-center gap-2 text-xs">
                    {m.carte_scrim_label()}
                    <input
                      type="range"
                      min="0"
                      max="80"
                      bind:value={scrimOpacity}
                      class="accent-accent"
                    />
                  </label>
                {/if}
              </div>

              <label class="text-text-muted inline-flex items-center gap-2 text-xs font-semibold">
                <input type="checkbox" bind:checked={directoryVisible} class="accent-accent" />
                {m.carte_directory_toggle()}
              </label>

              <div class="text-text-muted flex items-center gap-2 text-xs font-semibold">
                <span>{m.carte_title_color_label()}</span>
                <ColorPicker bind:value={titleColor} label={m.carte_title_color_label()} />
              </div>

              <Button variant="secondary" size="compact" onclick={addText}>
                <Type size={15} />
                {m.carte_add_text()}
              </Button>

              <p class="text-text-muted text-xs">{m.carte_editor_hint()}</p>
              <p class="text-text-muted text-xs">{m.carte_generated_note()}</p>
            </section>
          </aside>
        {/if}
      </div>
    {/if}
  </div>
{/if}
