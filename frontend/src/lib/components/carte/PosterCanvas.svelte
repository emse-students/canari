<script lang="ts">
  import { getInitials } from '$lib/utils/avatar';
  import type { CarteTheme } from '$lib/carte/theme';
  import type { PosterModel, PosterBubble } from '$lib/carte/generator';
  import {
    STAGE_WIDTH,
    CARD_WIDTH,
    TEXT_BASE_WIDTH,
    TEXT_BASE_SIZE,
    type PositionedBubble,
    type Decoration,
  } from '$lib/carte/layout';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Zoned model (used for the directory footer + counts). */
    model: PosterModel;
    /** Resolved content per association id (name, logo, president, ...). */
    content: Record<string, PosterBubble>;
    /** Hand-placed bubble positions to render on the stage. */
    bubbles: PositionedBubble[];
    /** Free-form decorations (text, later doodles + blobs) rendered on the same stage. */
    decorations: Decoration[];
    theme: CarteTheme;
    /** Poster title (the project name). */
    title: string;
    /** Optional background image + scrim. */
    background: { dataUrl: string | null; scrimOpacity: number };
    /** Stage height in poster px (parent keeps it in sync with the placed bubbles). */
    canvasHeight: number;
    /** Whether the text directory footer is rendered. */
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
    canvasHeight,
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

  const MIN_SCALE = 0.4;
  const MAX_SCALE = 2.6;

  /** The stage element, used to convert client pointer coords into poster coords. */
  let stageEl = $state<HTMLElement>();

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
        originX: number;
        originY: number;
        px0: number;
        py0: number;
        rectLeft: number;
        rectTop: number;
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
    select(target, id);
    const rect = stageEl.getBoundingClientRect();
    drag = {
      mode: 'move',
      target,
      id,
      scale,
      baseWidth,
      originX: x,
      originY: y,
      px0: (event.clientX - rect.left) / viewScale,
      py0: (event.clientY - rect.top) / viewScale,
      rectLeft: rect.left,
      rectTop: rect.top,
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
    const root = (event.currentTarget as HTMLElement).closest(
      '[data-el-root]'
    ) as HTMLElement | null;
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
      const maxX = Math.max(0, STAGE_WIDTH - drag.baseWidth * drag.scale);
      const nx = clamp(drag.originX + (px - drag.px0), 0, maxX);
      const ny = Math.max(0, drag.originY + (py - drag.py0));
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
    detachWindow();
  }

  const CORNERS = [
    { key: 'nw', pos: 'top:-7px;left:-7px;', cursor: 'nwse-resize' },
    { key: 'ne', pos: 'top:-7px;right:-7px;', cursor: 'nesw-resize' },
    { key: 'sw', pos: 'bottom:-7px;left:-7px;', cursor: 'nesw-resize' },
    { key: 'se', pos: 'bottom:-7px;right:-7px;', cursor: 'nwse-resize' },
  ];
</script>

<!-- The poster IS the export target: fixed pixel size, absolute layers, self-contained styles. -->
<div
  bind:this={el}
  style:width="{STAGE_WIDTH}px"
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
      style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"
    />
    <div
      style:position="absolute"
      style:inset="0"
      style:background={theme.scrimColor}
      style:opacity={background.scrimOpacity / 100}
    ></div>
  {/if}

  <!-- Freeform bubble stage. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={stageEl}
    style:position="relative"
    style:height="{canvasHeight}px"
    onpointerdown={stagePointerDown}
  >
    <div style="position:absolute;top:40px;left:56px;right:56px;pointer-events:none;">
      <h1
        style:font-family="'Fredoka Variable', 'Fredoka', 'Segoe UI', sans-serif"
        style:font-size="52px"
        style:font-weight="700"
        style:margin="0 0 6px"
        style:color={theme.titleColor}
      >
        {title}
      </h1>
      <p style:margin="0" style:font-size="18px" style:opacity="0.75">
        {m.carte_poster_subtitle({ count: model.totalAssos })}
      </p>
    </div>

    {#if model.totalAssos === 0}
      <p style="position:absolute;top:150px;left:56px;font-size:20px;opacity:0.7;">
        {m.carte_empty()}
      </p>
    {/if}

    {#each bubbles as bubble (bubble.assoId)}
      {@const data = content[bubble.assoId]}
      {#if data}
        {@const color = bubble.colorOverride ?? data.color}
        {@const selected = editable && selectedId === bubble.assoId}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="carte-card"
          data-el-root
          style:position="absolute"
          style:left="{bubble.x}px"
          style:top="{bubble.y}px"
          style:z-index={bubble.z}
          style:width="{CARD_WIDTH}px"
          style:transform="scale({bubble.scale})"
          style:transform-origin="top left"
          style:display="flex"
          style:flex-direction="column"
          style:align-items="center"
          style:touch-action="none"
          style:cursor={editable ? 'grab' : 'default'}
          style:outline={selected ? '3px solid #f5c518' : 'none'}
          style:outline-offset="6px"
          style:border-radius="12px"
          onpointerdown={(e) =>
            beginMove(e, 'bubble', bubble.assoId, bubble.x, bubble.y, bubble.scale, CARD_WIDTH)}
        >
          <!-- Brand-color disc with the logo (initials behind as fallback). -->
          <div
            style:position="relative"
            style:width="132px"
            style:height="132px"
            style:border-radius="50%"
            style:overflow="hidden"
            style:background={color}
            style:display="flex"
            style:align-items="center"
            style:justify-content="center"
            style:color="#ffffff"
            style:font-weight="800"
            style:font-size="42px"
            style:box-shadow="0 6px 18px rgba(0,0,0,0.18)"
          >
            <span>{getInitials(data.name)}</span>
            {#if data.logoUrl}
              <img
                src={data.logoUrl}
                alt=""
                onerror={hideOnError}
                style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"
              />
            {/if}
          </div>

          <p
            style:margin="12px 0 0"
            style:font-size="18px"
            style:font-weight="800"
            style:text-align="center"
            style:line-height="1.2"
            style:color={theme.bubbleNameColor}
          >
            {data.name}
          </p>

          {#if bubble.showPresident && data.president}
            <!-- President polaroid: avatar + name + role. -->
            <div
              style:margin-top="14px"
              style:background={theme.polaroidBg}
              style:border-radius="10px"
              style:padding="8px 8px 10px"
              style:width="128px"
              style:box-shadow="0 5px 14px rgba(0,0,0,0.2)"
            >
              <div
                style:position="relative"
                style:width="112px"
                style:height="96px"
                style:border-radius="6px"
                style:overflow="hidden"
                style:background={color}
                style:display="flex"
                style:align-items="center"
                style:justify-content="center"
                style:color="#ffffff"
                style:font-weight="800"
                style:font-size="30px"
              >
                <span>{getInitials(data.president.name)}</span>
                <img
                  src={`/api/users/${encodeURIComponent(data.president.userId)}/avatar`}
                  alt=""
                  onerror={hideOnError}
                  style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;"
                />
              </div>
              <p
                style:margin="7px 0 0"
                style:font-size="12.5px"
                style:font-weight="700"
                style:text-align="center"
                style:line-height="1.2"
                style:color={theme.polaroidTextColor}
              >
                {data.president.name}
              </p>
              <p
                style:margin="1px 0 0"
                style:font-size="11px"
                style:text-align="center"
                style:opacity="0.7"
                style:color={theme.polaroidTextColor}
              >
                {data.president.role}
              </p>
            </div>
          {/if}

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

    <!-- Free-form decoration layer (text; later doodles + blobs). -->
    {#each decorations as deco (deco.id)}
      {#if deco.kind === 'text'}
        {@const dsel = editable && selectedDecorationId === deco.id}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          data-el-root
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
  </div>

  {#if directoryVisible && model.totalAssos > 0}
    <!-- Themed text directory grouped by zone (fixed footer below the freeform stage). -->
    <section
      style:position="relative"
      style:margin="0 56px 56px"
      style:background={theme.directoryBg}
      style:border-radius="20px"
      style:padding="28px 32px"
    >
      <h2
        style:font-family="'Fredoka Variable', 'Fredoka', 'Segoe UI', sans-serif"
        style:font-size="24px"
        style:font-weight="800"
        style:margin="0 0 18px"
        style:color={theme.directoryTextColor}
      >
        {m.carte_directory_heading()}
      </h2>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px 40px;">
        {#each model.zones as zone (zone.categoryId ?? 'none')}
          <div style="break-inside:avoid;">
            <h3
              style:font-size="15px"
              style:font-weight="800"
              style:text-transform="uppercase"
              style:letter-spacing="0.04em"
              style:margin="0 0 8px"
              style:color={theme.directoryMutedColor}
            >
              {zone.label}
            </h3>
            {#each zone.bubbles as bubble (bubble.assoId)}
              <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:5px;">
                <span
                  style:flex="0 0 auto"
                  style:width="10px"
                  style:height="10px"
                  style:border-radius="50%"
                  style:background={bubble.color}
                  style:transform="translateY(1px)"
                ></span>
                <span style="font-size:14px;line-height:1.35;color:{theme.directoryTextColor};">
                  <span style="font-weight:800;">{bubble.name}</span>
                  {#if bubble.president}
                    <span style="color:{theme.directoryMutedColor};">
                      - {bubble.president.name}</span
                    >
                  {/if}
                  {#if bubble.contactEmail}
                    <span style="color:{theme.directoryMutedColor};"> - {bubble.contactEmail}</span>
                  {/if}
                </span>
              </div>
            {/each}
          </div>
        {/each}
      </div>
    </section>
  {/if}
</div>
