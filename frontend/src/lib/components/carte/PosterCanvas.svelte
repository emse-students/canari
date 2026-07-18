<script lang="ts">
  import { getInitials } from '$lib/utils/avatar';
  import type { CarteStyle } from '$lib/carte/theme';
  import type { PosterModel, PosterBubble, PosterMemberRef } from '$lib/carte/generator';
  import {
    STAGE_WIDTH,
    STAGE_HEIGHT,
    DIRECTORY_WIDTH,
    CARD_WIDTH,
    CARD_HEIGHT,
    TEXT_BASE_WIDTH,
    TEXT_BASE_SIZE,
    BUREAU_CROWN_CY,
    bureauCrownOffset,
    type PositionedBubble,
    type Decoration,
  } from '$lib/carte/layout';
  import { shapeRadius, logoShape } from '$lib/carte/shapes';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Zoned model (used for the directory column + counts). */
    model: PosterModel;
    /** Resolved content per association id (name, logo, president, bureau, members). */
    content: Record<string, PosterBubble>;
    /** Hand-placed bubble positions to render on the stage. */
    bubbles: PositionedBubble[];
    /** Free-form decorations (free text) rendered on the same stage. */
    decorations: Decoration[];
    theme: CarteStyle;
    /** Poster title (the project name). */
    title: string;
    /** Optional background image + scrim. */
    background: { dataUrl: string | null; scrimOpacity: number };
    /** Whether the right-hand member directory column is rendered. */
    directoryVisible: boolean;
    /** Enables drag / resize / selection. False renders a static (export-ready) poster. */
    editable?: boolean;
    /** On-screen preview scale, so pointer deltas convert back to poster px. */
    viewScale?: number;
    /** Currently selected bubble (shows outline + resize handles). */
    selectedId?: string | null;
    /** Currently selected decoration (shows outline + resize handles). */
    selectedDecorationId?: string | null;
    /** Fired when a bubble is picked (or the empty stage clears the selection with null). */
    onSelect?: (id: string | null) => void;
    /** Fired when a decoration is picked (or the empty stage clears it with null). */
    onSelectDecoration?: (id: string | null) => void;
    /** Fired continuously during a bubble drag / resize with the changed placement fields. */
    onChange?: (id: string, patch: Partial<PositionedBubble>) => void;
    /** Fired continuously during a decoration drag / resize with the changed placement fields. */
    onChangeDecoration?: (id: string, patch: Partial<Decoration>) => void;
    /** Bound to the parent so it can rasterise this exact node for PDF export. */
    el?: HTMLElement;
  }

  let {
    model,
    content,
    bubbles,
    decorations,
    theme,
    title,
    background,
    directoryVisible,
    editable = false,
    viewScale = 1,
    selectedId = null,
    selectedDecorationId = null,
    onSelect,
    onSelectDecoration,
    onChange,
    onChangeDecoration,
    el = $bindable(),
  }: Props = $props();

  const MIN_SCALE = 0.3;
  const MAX_SCALE = 2.6;
  /** How close (poster px) an edge/center must be to a guide before it snaps. */
  const SNAP_THRESHOLD = 8;
  /** Stage side padding shared by the title, offered as an alignment guide. */
  const CONTENT_MARGIN = 48;

  // ── Blob-unit geometry (poster px, at scale 1) ──────────────────────────────────────────
  // The unit layers, from back to front: a colored blob (silhouette); the hero logo centered on it
  // (its own shape, allowed to overflow the blob); the president as a card overlapping the blob
  // bottom; the bureau as cards fanned over the blob's TOP arc; and the association name in a band
  // BELOW the blob (so a long name wraps + shrinks instead of being clipped).
  /** Horizontal center of the unit box; the blob + logo + bureau arc are centered on it. */
  const UNIT_CX = CARD_WIDTH / 2;
  /** Vertical center of the blob within the unit. */
  const BLOB_CY = 172;
  /** Diameter of the colored association blob. */
  const BLOB_SIZE = 210;
  /** Base logo size (px); the logo shape scales this by its w/h ratio and may overflow the blob. */
  const LOGO_BASE = 92;
  /** Logo center Y: upper part of the blob, so the association name fits inside below it. */
  const LOGO_CY = BLOB_CY - 38;
  /** Association-name box top (inside the blob, below the logo). */
  const NAME_TOP = BLOB_CY + 12;
  /** Bureau member-card width. */
  const CARD_W = 68;
  /** President member-card width (a touch larger; sits at the blob bottom). */
  const PRES_CARD_W = 92;
  /** President card top: below the logo + name, hanging off the blob's bottom rim. */
  const PRES_TOP = BLOB_CY + 74;
  /** Max bureau cards fanned over the blob's top arc before it gets too crowded. */
  const MAX_BUREAU = 8;
  /** Length-based font size (px) for the association name below the blob, so long names shrink. */
  function nameFontSize(name: string): number {
    const n = name.length;
    if (n <= 12) return 24;
    if (n <= 18) return 21;
    if (n <= 26) return 18;
    if (n <= 36) return 15;
    return 13;
  }
  /** Length- and width-based name font size (px) for a member card (bureau / president), which wraps. */
  function cardNameFontSize(name: string, cardW: number, base: number): number {
    const n = name.length;
    const widthPenalty = cardW <= 70 ? 0.8 : cardW <= 85 ? 0.4 : 0;
    if (n <= 12) return base - widthPenalty;
    if (n <= 18) return base - 0.8 - widthPenalty;
    if (n <= 26) return base - 1.6 - widthPenalty;
    if (n <= 36) return base - 2.4 - widthPenalty;
    return base - 3.2 - widthPenalty;
  }

  /** The stage element, used to convert client pointer coords into poster coords. */
  let stageEl = $state<HTMLElement>();

  /** Active alignment guide lines shown during a move (poster px), or null when not aligned. */
  let snapLines = $state<{ x: number | null; y: number | null }>({
    x: null,
    y: null,
  });

  /** Right edge available to bubbles (the directory column is reserved on the right when shown). */
  const bubbleLimitX = $derived(directoryVisible ? STAGE_WIDTH - DIRECTORY_WIDTH : STAGE_WIDTH);

  /** Which layer a gesture is acting on, so a change routes to the right callback. */
  type DragTarget = 'bubble' | 'decoration';

  /** Active drag/resize gesture, or null when idle. Shared by bubbles and decorations. */
  type Drag =
    | {
        mode: 'move';
        target: DragTarget;
        id: string;
        scale: number;
        baseWidth: number;
        /** Right limit for this gesture's X (bubbles stop before the directory column). */
        limitX: number;
        originX: number;
        originY: number;
        px0: number;
        py0: number;
        rectLeft: number;
        rectTop: number;
        /** Dragged element footprint in poster px (for center/right/bottom anchors + clamps). */
        w0: number;
        h0: number;
        /** Vertical / horizontal guide lines (poster px) collected from the other elements. */
        vGuides: number[];
        hGuides: number[];
      }
    | {
        mode: 'resize';
        target: DragTarget;
        id: string;
        baseWidth: number;
        cx: number;
        cy: number;
        baseH: number;
        startScale: number;
        r0: number;
        rectLeft: number;
        rectTop: number;
      };
  let drag: Drag | null = null;

  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

  /** Hides a broken avatar/logo image so the colored initials layer behind it shows through. */
  function hideOnError(event: Event) {
    (event.currentTarget as HTMLImageElement).style.display = 'none';
  }

  function attachWindow() {
    window.addEventListener('pointermove', onWindowMove);
    window.addEventListener('pointerup', onWindowUp);
  }
  function detachWindow() {
    window.removeEventListener('pointermove', onWindowMove);
    window.removeEventListener('pointerup', onWindowUp);
  }

  /** Routes a placement patch to the right layer's change callback. */
  function emitChange(
    target: DragTarget,
    id: string,
    patch: { x?: number; y?: number; scale?: number }
  ) {
    if (target === 'bubble') onChange?.(id, patch);
    else onChangeDecoration?.(id, patch);
  }

  /** Selects an element on one layer and clears the other layer's selection. */
  function select(target: DragTarget, id: string) {
    if (target === 'bubble') {
      onSelectDecoration?.(null);
      onSelect?.(id);
    } else {
      onSelect?.(null);
      onSelectDecoration?.(id);
    }
  }

  /** Clears both selections when the bare stage (not an element) is pressed. */
  function stagePointerDown(event: PointerEvent) {
    if (!editable) return;
    if (!(event.target as HTMLElement).closest('[data-el-root]')) {
      onSelect?.(null);
      onSelectDecoration?.(null);
    }
  }

  /**
   * Snapshots the vertical/horizontal alignment guides offered by every element except the one
   * being dragged, plus the stage center + content margins. Rects are read live from the DOM (so
   * variable-height bubbles contribute accurate edges) and converted into poster px.
   */
  function collectGuides(stageRect: DOMRect, draggedId: string): { v: number[]; h: number[] } {
    const v = [STAGE_WIDTH / 2, CONTENT_MARGIN, bubbleLimitX - CONTENT_MARGIN];
    const h: number[] = [STAGE_HEIGHT / 2];
    if (!stageEl) return { v, h };
    for (const node of stageEl.querySelectorAll<HTMLElement>('[data-el-root]')) {
      if (node.dataset.elId === draggedId) continue;
      const r = node.getBoundingClientRect();
      const left = (r.left - stageRect.left) / viewScale;
      const top = (r.top - stageRect.top) / viewScale;
      const w = r.width / viewScale;
      const hgt = r.height / viewScale;
      v.push(left, left + w / 2, left + w);
      h.push(top, top + hgt / 2, top + hgt);
    }
    return { v, h };
  }

  /**
   * Finds the closest guide within {@link SNAP_THRESHOLD} of any anchor. Returns the delta to add
   * to align the anchor onto that guide, plus the guide coordinate (to draw), or null if none.
   */
  function nearestSnap(
    anchors: number[],
    guides: number[]
  ): { delta: number; line: number } | null {
    let best: { delta: number; line: number; dist: number } | null = null;
    for (const a of anchors) {
      for (const line of guides) {
        const dist = Math.abs(line - a);
        if (dist <= SNAP_THRESHOLD && (!best || dist < best.dist)) {
          best = { delta: line - a, line, dist };
        }
      }
    }
    return best ? { delta: best.delta, line: best.line } : null;
  }

  /** Begins moving a bubble or decoration. */
  function beginMove(
    event: PointerEvent,
    target: DragTarget,
    id: string,
    x: number,
    y: number,
    scale: number,
    baseWidth: number
  ) {
    if (!editable || !stageEl) return;
    event.stopPropagation();
    // Suppress the browser's native image drag / text selection so the pointer gesture is not
    // hijacked (the "component only drops on the next click" bug); capture keeps events flowing.
    event.preventDefault();
    const grabEl = event.currentTarget as HTMLElement;
    grabEl.setPointerCapture?.(event.pointerId);
    select(target, id);
    const rect = stageEl.getBoundingClientRect();
    const self = grabEl.getBoundingClientRect();
    const guides = collectGuides(rect, id);
    drag = {
      mode: 'move',
      target,
      id,
      scale,
      baseWidth,
      // Bubbles stop before the directory column; free text may roam the whole frame.
      limitX: target === 'bubble' ? bubbleLimitX : STAGE_WIDTH,
      originX: x,
      originY: y,
      px0: (event.clientX - rect.left) / viewScale,
      py0: (event.clientY - rect.top) / viewScale,
      rectLeft: rect.left,
      rectTop: rect.top,
      w0: self.width / viewScale,
      h0: self.height / viewScale,
      vGuides: guides.v,
      hGuides: guides.h,
    };
    attachWindow();
  }

  /** Begins resizing a bubble or decoration. Any corner drives a uniform, center-fixed scale. */
  function beginResize(
    event: PointerEvent,
    target: DragTarget,
    id: string,
    x: number,
    y: number,
    scale: number,
    baseWidth: number
  ) {
    if (!editable || !stageEl) return;
    event.stopPropagation();
    event.preventDefault();
    const handleEl = event.currentTarget as HTMLElement;
    handleEl.setPointerCapture?.(event.pointerId);
    const root = handleEl.closest('[data-el-root]') as HTMLElement | null;
    if (!root) return;
    const rect = stageEl.getBoundingClientRect();
    const ch = root.getBoundingClientRect().height / viewScale; // scaled height in poster px
    const cw = baseWidth * scale;
    const cx = x + cw / 2;
    const cy = y + ch / 2;
    const px = (event.clientX - rect.left) / viewScale;
    const py = (event.clientY - rect.top) / viewScale;
    drag = {
      mode: 'resize',
      target,
      id,
      baseWidth,
      cx,
      cy,
      baseH: ch / scale, // unscaled content height, so scale maps back to px
      startScale: scale,
      r0: Math.max(1, Math.hypot(px - cx, py - cy)),
      rectLeft: rect.left,
      rectTop: rect.top,
    };
    attachWindow();
  }

  function onWindowMove(event: PointerEvent) {
    if (!drag) return;
    const px = (event.clientX - drag.rectLeft) / viewScale;
    const py = (event.clientY - drag.rectTop) / viewScale;
    if (drag.mode === 'move') {
      // Elements may be pushed right up to (and partly past) any edge - only KEEP px must stay
      // on-frame - so the margins are fully usable. The directory column is no longer a hard limit.
      const KEEP = 40;
      const minX = -(drag.w0 - KEEP);
      const maxX = STAGE_WIDTH - KEEP;
      const minY = -(drag.h0 - KEEP);
      const maxY = STAGE_HEIGHT - KEEP;
      let nx = clamp(drag.originX + (px - drag.px0), minX, maxX);
      let ny = clamp(drag.originY + (py - drag.py0), minY, maxY);
      // Alt bypasses snapping for free placement; otherwise pull edges/centers onto guides.
      let vLine: number | null = null;
      let hLine: number | null = null;
      if (!event.altKey) {
        const sx = nearestSnap([nx, nx + drag.w0 / 2, nx + drag.w0], drag.vGuides);
        if (sx) {
          nx = clamp(nx + sx.delta, minX, maxX);
          vLine = sx.line;
        }
        const sy = nearestSnap([ny, ny + drag.h0 / 2, ny + drag.h0], drag.hGuides);
        if (sy) {
          ny = clamp(ny + sy.delta, minY, maxY);
          hLine = sy.line;
        }
      }
      snapLines = { x: vLine, y: hLine };
      emitChange(drag.target, drag.id, { x: nx, y: ny });
    } else {
      const r = Math.max(1, Math.hypot(px - drag.cx, py - drag.cy));
      const ns = clamp(drag.startScale * (r / drag.r0), MIN_SCALE, MAX_SCALE);
      emitChange(drag.target, drag.id, {
        scale: ns,
        x: Math.max(0, drag.cx - (drag.baseWidth * ns) / 2),
        y: Math.max(0, drag.cy - (drag.baseH * ns) / 2),
      });
    }
  }

  function onWindowUp() {
    drag = null;
    snapLines = { x: null, y: null };
    detachWindow();
  }

  const CORNERS = [
    { key: 'nw', pos: 'top:-7px;left:-7px;', cursor: 'nwse-resize' },
    { key: 'ne', pos: 'top:-7px;right:-7px;', cursor: 'nesw-resize' },
    { key: 'sw', pos: 'bottom:-7px;left:-7px;', cursor: 'nesw-resize' },
    { key: 'se', pos: 'bottom:-7px;right:-7px;', cursor: 'nwse-resize' },
  ];

  // ── Adaptive directory font ─────────────────────────────────────────────────────────────
  /** Base directory font size (px); item text uses em so it scales with this. */
  const DIR_BASE_FONT = 13;
  /** The directory body (fixed-height, clipped) and its multi-column content, for auto-fitting. */
  let dirBodyEl = $state<HTMLElement>();
  let dirContentEl = $state<HTMLElement>();

  /**
   * Shrinks the directory font until every member fits the fixed column (which would otherwise be
   * clipped for a large roster). Sizes are applied imperatively (not via reactive state) so the
   * measurement loop never re-triggers itself; item text is in em, so scaling the wrapper font-size
   * scales the whole list. Re-runs when the roster or the directory visibility changes.
   */
  $effect(() => {
    // Establish reactive deps.
    const zones = model.zones;
    const visible = directoryVisible;
    const body = dirBodyEl;
    const contentNode = dirContentEl;
    if (!visible || !body || !contentNode || zones.length === 0) return;
    const raf = requestAnimationFrame(() => {
      const avail = body.clientHeight;
      let font = DIR_BASE_FONT;
      contentNode.style.fontSize = `${font}px`;
      // Step down until it fits or we hit a readable floor.
      while (contentNode.scrollHeight > avail && font > DIR_BASE_FONT * 0.5) {
        font -= 0.5;
        contentNode.style.fontSize = `${font}px`;
      }
    });
    return () => cancelAnimationFrame(raf);
  });
</script>

<!-- A member card (bureau / president): square photo + full name (wraps, never truncated) + role. -->
{#snippet memberCard(person: PosterMemberRef, cardW: number, color: string, nameBase: number)}
  <div
    style:width="{cardW}px"
    style:background={theme.polaroidBg}
    style:border-radius="9px"
    style:padding="6px 6px 7px"
    style:box-shadow="0 4px 11px rgba(0,0,0,0.22)"
  >
    <div
      style:position="relative"
      style:width="{cardW - 12}px"
      style:height="{cardW - 12}px"
      style:border-radius="7px"
      style:overflow="hidden"
      style:background={color}
      style:display="flex"
      style:align-items="center"
      style:justify-content="center"
      style:color="#ffffff"
      style:font-weight="800"
      style:font-size="22px"
    >
      <span>{getInitials(person.name)}</span>
      <img
        src={`/api/users/${encodeURIComponent(person.userId)}/avatar`}
        alt=""
        draggable="false"
        onerror={hideOnError}
        style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;-webkit-user-drag:none;"
      />
    </div>
    <p
      data-pdf-text
      style:margin="4px 0 0"
      style:font-size="{cardNameFontSize(person.name, cardW, nameBase)}px"
      style:font-weight="700"
      style:text-align="center"
      style:line-height="1.1"
      style:color={theme.polaroidTextColor}
      style="overflow-wrap:anywhere;word-break:break-word;"
    >
      {person.name}
    </p>
    {#if person.role}
      <p
        data-pdf-text
        style:margin="1px 0 0"
        style:font-size="{nameBase - 2.5}px"
        style:font-weight="600"
        style:text-align="center"
        style:line-height="1.05"
        style:color={theme.polaroidTextColor}
        style="opacity:0.72;overflow-wrap:anywhere;word-break:break-word;"
      >
        {person.role}
      </p>
    {/if}
  </div>
{/snippet}

<!-- The poster IS the export target: a fixed A2-landscape frame, absolute layers, self-contained. -->
<div
  bind:this={el}
  style:width="{STAGE_WIDTH}px"
  style:height="{STAGE_HEIGHT}px"
  style:position="relative"
  style:overflow="hidden"
  style:background={theme.pageBg}
  style:color={theme.bubbleNameColor}
  style:font-family="'Nunito Variable', 'Nunito', 'Segoe UI', sans-serif"
>
  {#if background.dataUrl}
    <img
      src={background.dataUrl}
      alt=""
      draggable="false"
      style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;-webkit-user-drag:none;"
    />
    <div
      style:position="absolute"
      style:inset="0"
      style:background={theme.scrimColor}
      style:opacity={background.scrimOpacity / 100}
    ></div>
  {/if}

  <!-- Freeform bubble stage (fills the whole A2 frame). -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={stageEl}
    style:position="absolute"
    style:inset="0"
    style:isolation="isolate"
    onpointerdown={stagePointerDown}
  >
    <div
      style:position="absolute"
      style:top="36px"
      style:left="{CONTENT_MARGIN}px"
      style:width="{bubbleLimitX - 2 * CONTENT_MARGIN}px"
      style:pointer-events="none"
    >
      <h1
        data-pdf-text
        style:font-family="'Fredoka Variable', 'Fredoka', 'Segoe UI', sans-serif"
        style:font-size="52px"
        style:font-weight="700"
        style:margin="0"
        style:color={theme.titleColor}
      >
        {title}
      </h1>
    </div>

    {#if model.totalAssos === 0}
      <p style="position:absolute;top:150px;left:48px;font-size:20px;opacity:0.7;">
        {m.carte_empty()}
      </p>
    {/if}

    {#each bubbles as bubble (bubble.assoId)}
      {@const data = content[bubble.assoId]}
      {#if data}
        {@const color = bubble.colorOverride ?? data.color}
        {@const selected = editable && selectedId === bubble.assoId}
        {@const bureau = data.bureau.slice(0, MAX_BUREAU)}
        {@const ls = logoShape(bubble.logoShape)}
        {@const lw = LOGO_BASE * ls.w}
        {@const lh = LOGO_BASE * ls.h}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="carte-unit"
          data-el-root
          data-el-id={bubble.assoId}
          style:position="absolute"
          style:left="{bubble.x}px"
          style:top="{bubble.y}px"
          style:z-index={bubble.z}
          style:width="{CARD_WIDTH}px"
          style:height="{CARD_HEIGHT}px"
          style:transform="scale({bubble.scale})"
          style:transform-origin="top left"
          style:touch-action="none"
          style:cursor={editable ? 'grab' : 'default'}
          style:outline={selected ? '3px solid #f5c518' : 'none'}
          style:outline-offset="4px"
          style:border-radius="16px"
          onpointerdown={(e) =>
            beginMove(e, 'bubble', bubble.assoId, bubble.x, bubble.y, bubble.scale, CARD_WIDTH)}
        >
          <!-- Blob silhouette (back layer): a plain brand-color shape the other layers sit on. -->
          <div
            style:position="absolute"
            style:left="{UNIT_CX - BLOB_SIZE / 2}px"
            style:top="{BLOB_CY - BLOB_SIZE / 2}px"
            style:width="{BLOB_SIZE}px"
            style:height="{BLOB_SIZE}px"
            style:border-radius={shapeRadius(bubble.shape)}
            style:background={color}
            style:box-shadow="0 8px 22px rgba(0,0,0,0.22)"
          ></div>

          <!-- Hero logo: its own frame shape, centered on the blob, allowed to overflow it. -->
          <div
            style:position="absolute"
            style:left="{UNIT_CX - lw / 2}px"
            style:top="{LOGO_CY - lh / 2}px"
            style:width="{lw}px"
            style:height="{lh}px"
            style:border-radius={ls.radius}
            style:overflow="hidden"
            style:background="rgba(255,255,255,0.94)"
            style:display="flex"
            style:align-items="center"
            style:justify-content="center"
            style:color
            style:font-weight="800"
            style:font-size="36px"
            style:box-shadow="0 4px 14px rgba(0,0,0,0.2)"
          >
            <span>{getInitials(data.name)}</span>
            {#if data.logoUrl}
              <img
                src={data.logoUrl}
                alt=""
                draggable="false"
                onerror={hideOnError}
                style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;-webkit-user-drag:none;"
              />
            {/if}
          </div>

          <!-- Bureau member-cards fanned over the blob's top arc, drawn AFTER so they sit IN FRONT. -->
          {#each bureau as member, i (member.userId)}
            {@const offset = bureauCrownOffset(i)}
            {@const px = UNIT_CX + offset.x - CARD_W / 2}
            {@const py = BUREAU_CROWN_CY + offset.y - CARD_W / 2}
            <div style:position="absolute" style:left="{px}px" style:top="{py}px">
              {@render memberCard(member, CARD_W, color, 9.6)}
            </div>
          {/each}

          <!-- President always a card (photo + full name + role), at the blob bottom, in front. -->
          {#if bubble.showPresident && data.president}
            <div
              style:position="absolute"
              style:left="{UNIT_CX - PRES_CARD_W / 2}px"
              style:top="{PRES_TOP}px"
            >
              {@render memberCard(data.president, PRES_CARD_W, color, 12)}
            </div>
          {/if}

          <!-- Association name INSIDE the blob (below the logo), white; wraps + shrinks to fit. -->
          <div
            style:position="absolute"
            style:left="{UNIT_CX - (BLOB_SIZE - 56) / 2}px"
            style:width="{BLOB_SIZE - 56}px"
            style:top="{NAME_TOP}px"
            style:text-align="center"
          >
            <p
              data-pdf-text
              style:margin="0"
              style:font-size="{nameFontSize(data.name)}px"
              style:font-weight="800"
              style:line-height="1.1"
              style:color="#ffffff"
              style="overflow-wrap:break-word;text-shadow:0 1px 3px rgba(0,0,0,0.45);"
            >
              {data.name}
            </p>
          </div>

          {#if selected}
            {#each CORNERS as corner (corner.key)}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                role="presentation"
                style="position:absolute;{corner.pos}width:14px;height:14px;border-radius:50%;background:#f5c518;border:2px solid #ffffff;box-shadow:0 1px 3px rgba(0,0,0,0.3);cursor:{corner.cursor};"
                onpointerdown={(e) =>
                  beginResize(
                    e,
                    'bubble',
                    bubble.assoId,
                    bubble.x,
                    bubble.y,
                    bubble.scale,
                    CARD_WIDTH
                  )}
              ></div>
            {/each}
          {/if}
        </div>
      {/if}
    {/each}

    <!-- Free-form decoration layer (free text). -->
    {#each decorations as deco (deco.id)}
      {#if deco.kind === 'text'}
        {@const dsel = editable && selectedDecorationId === deco.id}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          data-el-root
          data-el-id={deco.id}
          style:position="absolute"
          style:left="{deco.x}px"
          style:top="{deco.y}px"
          style:z-index={deco.z}
          style:width="{TEXT_BASE_WIDTH}px"
          style:transform="scale({deco.scale})"
          style:transform-origin="top left"
          style:touch-action="none"
          style:cursor={editable ? 'grab' : 'default'}
          style:outline={dsel ? '3px solid #f5c518' : 'none'}
          style:outline-offset="4px"
          style:border-radius="6px"
          onpointerdown={(e) =>
            beginMove(e, 'decoration', deco.id, deco.x, deco.y, deco.scale, TEXT_BASE_WIDTH)}
        >
          <div
            data-pdf-text={deco.content ? 'true' : null}
            style:font-family="'Fredoka Variable', 'Fredoka', 'Segoe UI', sans-serif"
            style:font-size="{TEXT_BASE_SIZE}px"
            style:font-weight={deco.bold ? '800' : '500'}
            style:text-align={deco.align}
            style:line-height="1.25"
            style:white-space="pre-wrap"
            style:overflow-wrap="break-word"
            style:color={deco.color}
          >
            {#if deco.content}{deco.content}{:else if editable}<span style:opacity="0.45"
                >{m.carte_text_placeholder()}</span
              >{/if}
          </div>

          {#if dsel}
            {#each CORNERS as corner (corner.key)}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                role="presentation"
                style="position:absolute;{corner.pos}width:14px;height:14px;border-radius:50%;background:#f5c518;border:2px solid #ffffff;box-shadow:0 1px 3px rgba(0,0,0,0.3);cursor:{corner.cursor};"
                onpointerdown={(e) =>
                  beginResize(
                    e,
                    'decoration',
                    deco.id,
                    deco.x,
                    deco.y,
                    deco.scale,
                    TEXT_BASE_WIDTH
                  )}
              ></div>
            {/each}
          {/if}
        </div>
      {/if}
    {/each}

    <!-- Alignment guides: shown only during an editable drag, never rasterised (no active drag on export). -->
    {#if editable && snapLines.x !== null}
      <div
        style="position:absolute;top:0;bottom:0;left:{snapLines.x}px;width:0;border-left:1px dashed #f5c518;pointer-events:none;z-index:9999;"
      ></div>
    {/if}
    {#if editable && snapLines.y !== null}
      <div
        style="position:absolute;left:0;right:0;top:{snapLines.y}px;height:0;border-top:1px dashed #f5c518;pointer-events:none;z-index:9999;"
      ></div>
    {/if}
  </div>

  {#if directoryVisible && model.totalAssos > 0}
    <!-- Member directory: a fixed right-hand column listing every member grouped by association. -->
    <aside
      style:position="absolute"
      style:top="48px"
      style:right="48px"
      style:bottom="48px"
      style:width="{DIRECTORY_WIDTH - 96}px"
      style:display="flex"
      style:flex-direction="column"
      style:overflow="hidden"
      style:background={theme.directoryBg}
      style:border-radius="20px"
      style:padding="24px 26px"
      style:box-shadow="0 10px 30px rgba(0,0,0,0.14)"
    >
      <h2
        data-pdf-text
        style:font-family="'Fredoka Variable', 'Fredoka', 'Segoe UI', sans-serif"
        style:font-size="24px"
        style:font-weight="800"
        style:margin="0 0 14px"
        style:flex="0 0 auto"
        style:color={theme.directoryTextColor}
      >
        {m.carte_directory_heading()}
      </h2>
      <!-- Fixed-height, clipped body: the effect above shrinks the font here until every name fits. -->
      <div bind:this={dirBodyEl} style="flex:1 1 auto;min-height:0;overflow:hidden;">
        <div
          bind:this={dirContentEl}
          style="columns:2;column-gap:24px;font-size:{DIR_BASE_FONT}px;"
        >
          {#each model.zones as zone (zone.categoryId ?? 'none')}
            {#each zone.bubbles as asso (asso.assoId)}
              <div style="break-inside:avoid;margin-bottom:0.9em;">
                <div style="display:flex;align-items:baseline;gap:0.5em;margin-bottom:0.2em;">
                  <span
                    style:flex="0 0 auto"
                    style:width="0.7em"
                    style:height="0.7em"
                    style:border-radius="50%"
                    style:background={asso.color}
                    style:transform="translateY(0.08em)"
                  ></span>
                  <span
                    data-pdf-text
                    style="font-size:1em;font-weight:800;line-height:1.2;color:{theme.directoryTextColor};"
                  >
                    {asso.name}
                  </span>
                </div>
                {#if asso.members.length > 0}
                  <p
                    data-pdf-text
                    style:margin="0 0 0 1.2em"
                    style:font-size="0.82em"
                    style:line-height="1.35"
                    style:color={theme.directoryMutedColor}
                  >
                    {asso.members
                      .map((mem) => (mem.role ? `${mem.name} (${mem.role})` : mem.name))
                      .join(' - ')}
                  </p>
                {/if}
              </div>
            {/each}
          {/each}
        </div>
      </div>
    </aside>
  {/if}
</div>
