<script lang="ts">
  import { getInitials } from '$lib/utils/avatar';
  import type { CarteTheme } from '$lib/carte/theme';
  import type { PosterModel, PosterBubble } from '$lib/carte/generator';
  import { STAGE_WIDTH, CARD_WIDTH, type PositionedBubble } from '$lib/carte/layout';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** Zoned model (used for the directory footer + counts). */
    model: PosterModel;
    /** Resolved content per association id (name, logo, president, ...). */
    content: Record<string, PosterBubble>;
    /** Hand-placed bubble positions to render on the stage. */
    bubbles: PositionedBubble[];
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
    /** Fired when a bubble is picked (or the empty stage clears the selection with null). */
    onSelect?: (id: string | null) => void;
    /** Fired continuously during a drag / resize with the changed placement fields. */
    onChange?: (id: string, patch: Partial<PositionedBubble>) => void;
    /** Bound to the parent so it can rasterise this exact node for PDF export. */
    el?: HTMLElement;
  }

  let {
    model,
    content,
    bubbles,
    theme,
    title,
    background,
    canvasHeight,
    directoryVisible,
    editable = false,
    viewScale = 1,
    selectedId = null,
    onSelect,
    onChange,
    el = $bindable(),
  }: Props = $props();

  const MIN_SCALE = 0.4;
  const MAX_SCALE = 2.6;

  /** The stage element, used to convert client pointer coords into poster coords. */
  let stageEl = $state<HTMLElement>();

  /** Active drag/resize gesture, or null when idle. */
  type Drag =
    | {
        mode: 'move';
        id: string;
        scale: number;
        originX: number;
        originY: number;
        px0: number;
        py0: number;
        rectLeft: number;
        rectTop: number;
      }
    | {
        mode: 'resize';
        id: string;
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

  /** Clears the selection when the bare stage (not a card) is pressed. */
  function stagePointerDown(event: PointerEvent) {
    if (!editable) return;
    if (!(event.target as HTMLElement).closest('.carte-card')) onSelect?.(null);
  }

  /** Begins moving a card. */
  function cardPointerDown(event: PointerEvent, bubble: PositionedBubble) {
    if (!editable || !stageEl) return;
    event.stopPropagation();
    onSelect?.(bubble.assoId);
    const rect = stageEl.getBoundingClientRect();
    drag = {
      mode: 'move',
      id: bubble.assoId,
      scale: bubble.scale,
      originX: bubble.x,
      originY: bubble.y,
      px0: (event.clientX - rect.left) / viewScale,
      py0: (event.clientY - rect.top) / viewScale,
      rectLeft: rect.left,
      rectTop: rect.top,
    };
    attachWindow();
  }

  /** Begins resizing a card. Any corner drives a uniform, center-fixed scale. */
  function handlePointerDown(event: PointerEvent, bubble: PositionedBubble) {
    if (!editable || !stageEl) return;
    event.stopPropagation();
    onSelect?.(bubble.assoId);
    const card = (event.currentTarget as HTMLElement).closest('.carte-card') as HTMLElement | null;
    if (!card) return;
    const rect = stageEl.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const cw = cardRect.width / viewScale; // scaled card width in poster px
    const ch = cardRect.height / viewScale;
    const cx = bubble.x + cw / 2;
    const cy = bubble.y + ch / 2;
    const px = (event.clientX - rect.left) / viewScale;
    const py = (event.clientY - rect.top) / viewScale;
    drag = {
      mode: 'resize',
      id: bubble.assoId,
      cx,
      cy,
      baseH: ch / bubble.scale, // unscaled content height, so scale maps back to px
      startScale: bubble.scale,
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
      const maxX = Math.max(0, STAGE_WIDTH - CARD_WIDTH * drag.scale);
      const nx = clamp(drag.originX + (px - drag.px0), 0, maxX);
      const ny = Math.max(0, drag.originY + (py - drag.py0));
      onChange?.(drag.id, { x: nx, y: ny });
    } else {
      const r = Math.max(1, Math.hypot(px - drag.cx, py - drag.cy));
      const ns = clamp(drag.startScale * (r / drag.r0), MIN_SCALE, MAX_SCALE);
      onChange?.(drag.id, {
        scale: ns,
        x: Math.max(0, drag.cx - (CARD_WIDTH * ns) / 2),
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
          onpointerdown={(e) => cardPointerDown(e, bubble)}
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
                onpointerdown={(e) => handlePointerDown(e, bubble)}
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
