<script lang="ts">
  /**
   * The post-capture editor (CanaReels, docs/wiki/frontend/modules/reel-editor.md): text and emoji
   * the member places, moves, pinches, twists and drops on a trash zone, plus a freehand pen whose
   * strokes are overlays too (an eraser wipes them, undo steps back). What is drawn here is baked
   * into the file by `renderEditedReelMedia`.
   *
   * WHAT YOU SEE IS WHAT IS PUBLISHED: the media sits in a frame of ITS OWN aspect ratio (never a
   * letterboxed one), every overlay is placed in 0..1 of that frame and sized from its short side
   * (`reelOverlays.ts`), and the export uses the same numbers on the media's own pixels.
   *
   * LAYOUT: one column - header, stage, tool tray - so nothing is ever drawn over the stage's own
   * controls, the home indicator is the tray's padding, and the keyboard (which resizes the layout
   * viewport) simply shortens the stage.
   *
   * GESTURES: ONE `TransformGesture` for every overlay kind. A finger on an overlay selects and
   * drags it; a second finger anywhere pinches and twists the same one; a tap on empty space
   * deselects; a tap on the already-selected text edits it; releasing over the trash deletes.
   */
  import { onDestroy } from 'svelte';
  import {
    Check,
    ChevronLeft,
    Eraser,
    Pencil,
    RectangleHorizontal,
    Smile,
    Trash2,
    Type,
    Undo2,
  } from '@lucide/svelte';
  import { TAP_SLOP_PX, TransformGesture, pointInRect } from '$lib/gestures/transformGesture';
  import type { ReelClip } from '$lib/reels/reelCapture';
  import { renderEditedReelMedia } from '$lib/reels/reelEditor';
  import {
    STROKE_WIDTHS,
    createStrokeOverlay,
    erasedAt,
    layoutChanged,
    pushedHistory,
    strokeBox,
    type FramePoint,
  } from '$lib/reels/reelStrokes';
  import {
    EMOJI_BASE_SIZE,
    TEXT_BASE_SIZE,
    emojiShelf,
    broughtToFront,
    createEmojiOverlay,
    createTextOverlay,
    PILL_PAD_X_EM,
    PILL_PAD_Y_EM,
    PILL_RADIUS_EM,
    TEXT_FONTS,
    TEXT_LINE_HEIGHT,
    fontStack,
    textPaint,
    withTextEdit,
    withTransform,
    withoutOverlay,
    type ReelOverlay,
    type ReelTextBackground,
    type ReelTextFont,
  } from '$lib/reels/reelOverlays';
  import EmojiGrid from '$lib/components/messages/EmojiGrid.svelte';
  import { getRecentEmojis, persistRecentEmoji } from '$lib/components/messages/emojiPickerShared';
  import { emojiSvgSrc } from '$lib/utils/emojiSvg';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    clip: ReelClip;
    oncancel: () => void;
    onapply: (blob: Blob) => void;
  }

  let { clip, oncancel, onapply }: Props = $props();
  let frame = $state<HTMLElement | null>(null);
  let trash = $state<HTMLElement | null>(null);
  let draftInput = $state<HTMLInputElement | null>(null);
  let color = $state('#ffffff');
  /** The text style in hand: what a new text starts with, and what the row edits on a selected one. */
  let font = $state<ReelTextFont>('sans');
  let background = $state<ReelTextBackground>('none');
  let busy = $state(false);
  let error = $state(false);
  let overlays = $state<ReelOverlay[]>([]);
  /** The layouts before each change, newest last: what "undo" steps back through. */
  let history = $state<ReelOverlay[][]>([]);
  let selectedId = $state<string | null>(null);
  /** arrange = move what is there; draw = a new stroke; erase = wipe the strokes the finger crosses. */
  let mode = $state<'arrange' | 'draw' | 'erase'>('arrange');
  let penWidth = $state<number>(STROKE_WIDTHS[1]);
  /** The stroke being drawn, in frame pixels: shown live, turned into an overlay on release. */
  let livePath = $state<FramePoint[]>([]);
  let frameSize = $state({ width: 0, height: 0 });
  let trayOpen = $state(false);
  /** The full picker (categories, search) is open under the quick shelf. */
  let gridOpen = $state(false);
  /** What the member used lately, shared with the chat's pickers; read when the tray opens. */
  let recents = $state<string[]>([]);
  const shelf = $derived(emojiShelf(recents));
  /** The text field is open: for a new text (`id` null) or to reword the one with that id. */
  let composing = $state<{ id: string | null } | null>(null);
  let draft = $state('');
  let dragging = $state(false);
  let overTrash = $state(false);
  /** The media's width / height, known once it has loaded; the frame takes this shape. */
  let ratio = $state(9 / 16);
  /** The pointer running a draw or erase pass, and whether that erase pass already took its undo step. */
  let paintingPointer: number | null = null;
  let erasedSomething = false;
  /** The layout when the running arrange gesture began, to tell a move from a mere tap. */
  let gestureStart: ReelOverlay[] = [];

  const colors = ['#ffffff', '#050505', '#ffcf33', '#f05b5b', '#5bd0f0'];
  const source = $derived(URL.createObjectURL(clip.blob));
  const isImage = $derived(clip.blob.type.startsWith('image/'));
  const selected = $derived(overlays.find((overlay) => overlay.id === selectedId) ?? null);
  const textToolsVisible = $derived(composing !== null || selected?.kind === 'text');
  const colorToolsVisible = $derived(mode === 'draw' || textToolsVisible);
  const widthLabels = [
    () => m.reels_editor_width_thin(),
    () => m.reels_editor_width_medium(),
    () => m.reels_editor_width_thick(),
  ];
  const fontLabels: Record<ReelTextFont, () => string> = {
    sans: () => m.reels_editor_font_sans(),
    serif: () => m.reels_editor_font_serif(),
    mono: () => m.reels_editor_font_mono(),
  };

  onDestroy(() => URL.revokeObjectURL(source));

  const gesture = new TransformGesture(() => {
    const bounds = frame?.getBoundingClientRect();
    return { width: bounds?.width ?? 0, height: bounds?.height ?? 0 };
  });
  /** The overlay the running gesture handles, and whether it was already selected when it began. */
  let gestureId: string | null = null;
  let wasSelected = false;

  $effect(() => {
    if (composing && draftInput) draftInput.focus();
  });

  function setRatio(width: number, height: number) {
    if (width > 0 && height > 0) {
      ratio = width / height;
      console.debug(`[reel-editor] frame is ${width}x${height}`);
    }
  }

  function overOverlayTrash(x: number, y: number): boolean {
    if (!trash) return false;
    return pointInRect({ x, y }, trash.getBoundingClientRect(), 12);
  }

  function arrangeDown(event: PointerEvent) {
    if (mode !== 'arrange' || !frame) return;
    if (!gesture.active) {
      const hit =
        (event.target as Element).closest<HTMLElement>('[data-overlay-id]')?.dataset.overlayId ??
        null;
      if (!hit) {
        selectedId = null;
        return;
      }
      wasSelected = selectedId === hit;
      selectedId = hit;
      gestureId = hit;
      gestureStart = overlays;
      overlays = broughtToFront(overlays, hit);
      const handled = overlays.find((overlay) => overlay.id === hit)!;
      // The swatches show (and a reword keeps) the colour of the text in hand.
      if (handled.kind === 'text') {
        color = handled.color;
        font = handled.font;
        background = handled.background;
      }
      gesture.begin(handled);
    }
    // A second finger joins the running gesture wherever it lands: that is the pinch.
    if (!gestureId) return;
    frame.setPointerCapture(event.pointerId);
    gesture.down(event.pointerId, { x: event.clientX, y: event.clientY });
    event.preventDefault();
  }

  function arrangeMove(event: PointerEvent) {
    if (!gestureId) return;
    const next = gesture.move(event.pointerId, { x: event.clientX, y: event.clientY });
    if (!next) return;
    overlays = withTransform(overlays, gestureId, next);
    dragging = gesture.travel > TAP_SLOP_PX;
    overTrash = dragging && overOverlayTrash(event.clientX, event.clientY);
  }

  function arrangeUp(event: PointerEvent) {
    if (!gestureId) return;
    const id = gestureId;
    gesture.up(event.pointerId);
    if (gesture.active) return;
    gestureId = null;
    const dropped =
      event.type === 'pointerup' && dragging && overOverlayTrash(event.clientX, event.clientY);
    if (dropped) {
      console.debug(`[reel-editor] overlay ${id} dropped on the trash`);
      overlays = withoutOverlay(overlays, id);
      selectedId = null;
    } else if (event.type === 'pointerup' && gesture.travel <= TAP_SLOP_PX && wasSelected) {
      const tapped = overlays.find((overlay) => overlay.id === id);
      if (tapped?.kind === 'text') {
        draft = tapped.text;
        font = tapped.font;
        background = tapped.background;
        composing = { id };
      }
    }
    // A tap or a reselection is not a change; a move, a pinch or a drop on the trash is, and is undoable.
    if (layoutChanged(gestureStart, overlays)) remember(gestureStart);
    dragging = false;
    overTrash = false;
  }

  /** Takes `before` (default: the layout now) as the state "undo" returns to. */
  function remember(before: ReelOverlay[] = overlays) {
    history = pushedHistory(history, before);
  }

  function undo() {
    const previous = history[history.length - 1];
    if (!previous) return;
    console.debug(`[reel-editor] undo: ${overlays.length} -> ${previous.length} overlays`);
    history = history.slice(0, -1);
    overlays = previous;
    selectedId = null;
  }

  /** A pointer position in the frame's own pixels, clamped to the frame. */
  function framePoint(event: PointerEvent): FramePoint | null {
    if (!frame) return null;
    const bounds = frame.getBoundingClientRect();
    frameSize = { width: bounds.width, height: bounds.height };
    return {
      x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)),
      y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)),
    };
  }

  /** Erase mode: every stroke under the finger goes; the first one of a pass takes the undo step. */
  function eraseAt(next: FramePoint) {
    const kept = erasedAt(overlays, next, frameSize.width, frameSize.height);
    if (kept === overlays) return;
    if (!erasedSomething) {
      remember();
      erasedSomething = true;
    }
    console.debug(`[reel-editor] erased ${overlays.length - kept.length} stroke(s)`);
    overlays = kept;
  }

  function paintDown(event: PointerEvent) {
    if (paintingPointer !== null) return;
    const next = framePoint(event);
    if (!next || !frame) return;
    paintingPointer = event.pointerId;
    frame.setPointerCapture(event.pointerId);
    event.preventDefault();
    erasedSomething = false;
    if (mode === 'erase') eraseAt(next);
    else livePath = [next];
  }

  function paintMove(event: PointerEvent) {
    if (paintingPointer !== event.pointerId) return;
    const next = framePoint(event);
    if (!next) return;
    if (mode === 'erase') eraseAt(next);
    else livePath = [...livePath, next];
  }

  function paintUp(event: PointerEvent) {
    if (paintingPointer !== event.pointerId) return;
    paintingPointer = null;
    const path = livePath;
    livePath = [];
    // A cancelled pointer (a call, a system gesture) never leaves half a line behind.
    if (mode !== 'draw' || event.type === 'pointercancel') return;
    const created = createStrokeOverlay(path, frameSize.width, frameSize.height, color, penWidth);
    if (!created) return;
    remember();
    overlays = [...overlays, created];
  }

  function openText() {
    mode = 'arrange';
    trayOpen = false;
    draft = '';
    composing = { id: null };
  }

  function commitText() {
    if (!composing) return;
    if (composing.id) {
      remember();
      overlays = withTextEdit(overlays, composing.id, { text: draft, color, font, background });
    } else {
      const created = createTextOverlay(draft, color, { font, background });
      if (created) {
        remember();
        overlays = [...overlays, created];
        selectedId = created.id;
      }
    }
    composing = null;
    draft = '';
  }

  function addEmoji(emoji: string) {
    const created = createEmojiOverlay(emoji);
    remember();
    overlays = [...overlays, created];
    selectedId = created.id;
    recents = persistRecentEmoji(emoji);
    trayOpen = false;
    gridOpen = false;
    mode = 'arrange';
  }

  function pickColor(swatch: string) {
    color = swatch;
    if (selected?.kind === 'text') {
      remember();
      overlays = withTextEdit(overlays, selected.id, { color: swatch });
    }
  }

  function pickWidth(width: number) {
    penWidth = width;
    console.debug(`[reel-editor] pen width ${width}`);
  }

  /** A style change applies at once to the text in hand (selected, or being reworded). */
  function pickStyle(edit: { font?: ReelTextFont; background?: ReelTextBackground }) {
    if (edit.font) font = edit.font;
    if (edit.background) background = edit.background;
    console.debug(`[reel-editor] text style ${font}/${background}`);
    const id = composing?.id ?? (selected?.kind === 'text' ? selected.id : null);
    if (id) {
      remember();
      overlays = withTextEdit(overlays, id, edit);
    }
  }

  /** Draw and erase are modes the same tool button toggles; leaving one returns to arranging. */
  function toggleMode(target: 'draw' | 'erase') {
    mode = mode === target ? 'arrange' : target;
    trayOpen = false;
    composing = null;
    selectedId = null;
  }

  function clearAll() {
    if (overlays.length === 0) return;
    remember();
    overlays = [];
    selectedId = null;
  }

  async function apply() {
    if (overlays.length === 0) {
      console.debug('[reel-editor] nothing was added: back to the take as it was');
      oncancel();
      return;
    }
    busy = true;
    error = false;
    selectedId = null;
    try {
      const fontFamily = frame ? getComputedStyle(frame).fontFamily : 'Nunito Variable, sans-serif';
      const edited = await renderEditedReelMedia(clip.blob, { overlays }, fontFamily);
      onapply(edited.blob);
    } catch (cause) {
      console.error('[reel-editor] export failed', cause);
      error = true;
      busy = false;
    }
  }

  const toolClass =
    'inline-flex h-11 w-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-amber-500';
</script>

<div class="absolute inset-0 z-20 flex flex-col bg-black text-white" data-reel-editor>
  <header
    class="flex shrink-0 items-center justify-between gap-2 px-3 pt-[calc(var(--safe-area-inset-top,0px)+0.5rem)] pb-2"
  >
    <button
      type="button"
      class="ui-icon-button"
      aria-label={m.reels_editor_back()}
      title={m.reels_editor_back()}
      onclick={oncancel}
    >
      <ChevronLeft size={24} strokeWidth={2.5} />
    </button>
    <h1 class="min-w-0 text-base font-bold">{m.reels_editor_title()}</h1>
    <button
      type="button"
      class="text-cn-ink inline-flex h-11 items-center gap-1.5 rounded-full bg-amber-500 px-4 text-sm font-bold outline-none hover:bg-amber-400 focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50"
      disabled={busy}
      onclick={apply}
      data-reel-editor-apply
    >
      <Check size={18} strokeWidth={2.5} />
      {busy ? m.reels_editor_exporting() : m.reels_editor_apply()}
    </button>
  </header>

  <!-- THE STAGE: the media's own box, as large as fits. `cqw`/`cqh` are the stage's size, so the
       frame never exceeds it and never takes a different shape from the media. -->
  <div
    class="relative flex min-h-0 flex-1 items-center justify-center"
    style="container-type: size"
  >
    <!-- Pointer-only by nature (a drag, a pinch): the keyboard and the screen reader reach the same
         actions through the tool buttons below, which add and clear what the gestures arrange. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      bind:this={frame}
      class="relative touch-none overflow-hidden select-none"
      style={`width: min(100cqw, calc(100cqh * ${ratio})); aspect-ratio: ${ratio}; container-type: size`}
      data-reel-frame
      onpointerdown={(event) => (mode === 'arrange' ? arrangeDown(event) : paintDown(event))}
      onpointermove={(event) => (mode === 'arrange' ? arrangeMove(event) : paintMove(event))}
      onpointerup={(event) => (mode === 'arrange' ? arrangeUp(event) : paintUp(event))}
      onpointercancel={(event) => (mode === 'arrange' ? arrangeUp(event) : paintUp(event))}
    >
      {#if isImage}
        <img
          src={source}
          alt=""
          draggable="false"
          class="absolute inset-0 h-full w-full"
          onload={(event) => {
            const picture = event.currentTarget as HTMLImageElement;
            setRatio(picture.naturalWidth, picture.naturalHeight);
          }}
        />
      {:else}
        <video
          src={source}
          autoplay
          muted
          loop
          playsinline
          class="absolute inset-0 h-full w-full"
          onloadedmetadata={(event) =>
            setRatio(event.currentTarget.videoWidth, event.currentTarget.videoHeight)}
        ></video>
      {/if}
      {#each overlays as overlay (overlay.id)}
        {@const picked = overlay.id === selectedId}
        <div
          data-overlay-id={overlay.id}
          data-overlay-kind={overlay.kind}
          data-overlay-scale={overlay.scale.toFixed(3)}
          class="absolute p-2 {mode !== 'arrange' ? 'pointer-events-none' : ''} {picked
            ? 'outline-2 outline-white/80 outline-dashed'
            : ''} rounded-lg"
          style={`left:${overlay.x * 100}%;top:${overlay.y * 100}%;transform:translate(-50%,-50%) rotate(${overlay.rotation}rad)`}
        >
          {#if overlay.kind === 'text'}
            {@const paint = textPaint(overlay)}
            <span
              class="block font-bold whitespace-nowrap {paint.pill
                ? ''
                : 'drop-shadow-[0_1px_3px_rgb(0_0_0/0.6)]'}"
              style={`color:${paint.fill};font-family:${fontStack(overlay.font, 'inherit')};font-size:${TEXT_BASE_SIZE * overlay.scale * 100}cqmin;line-height:${TEXT_LINE_HEIGHT};${paint.pill ? `background:${paint.pill};padding:${PILL_PAD_Y_EM}em ${PILL_PAD_X_EM}em;border-radius:${PILL_RADIUS_EM}em` : ''}`}
              >{overlay.text}</span
            >
          {:else if overlay.kind === 'stroke'}
            {@const box = strokeBox(overlay)}
            <!-- The stroke is drawn in short-side units: the viewBox is its padded box, the size the
                 same box times the scale in `cqmin`, as the export multiplies by the short side. -->
            <svg
              viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
              class="block max-w-none"
              style={`width:${box.width * overlay.scale * 100}cqmin;height:${box.height * overlay.scale * 100}cqmin`}
              aria-hidden="true"
            >
              <rect x={box.x} y={box.y} width={box.width} height={box.height} fill="transparent" />
              <polyline
                points={overlay.points.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke={overlay.color}
                stroke-width={overlay.width}
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          {:else}
            <img
              src={emojiSvgSrc(overlay.emoji) ?? ''}
              alt={overlay.emoji}
              draggable="false"
              class="block max-w-none"
              style={`width:${EMOJI_BASE_SIZE * overlay.scale * 100}cqmin;height:${EMOJI_BASE_SIZE * overlay.scale * 100}cqmin`}
            />
          {/if}
        </div>
      {/each}
      {#if livePath.length > 1}
        <svg class="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
          <polyline
            points={livePath.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke={color}
            stroke-width={penWidth * Math.min(frameSize.width, frameSize.height)}
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      {/if}
    </div>

    {#if dragging}
      <div
        bind:this={trash}
        class="absolute bottom-4 left-1/2 flex h-14 w-14 -translate-x-1/2 items-center justify-center rounded-full transition-transform {overTrash
          ? 'scale-125 bg-red-500'
          : 'bg-black/60'}"
        role="img"
        aria-label={m.reels_editor_trash()}
        data-reel-trash
      >
        <Trash2 size={24} strokeWidth={2.25} />
      </div>
    {/if}
  </div>

  <div
    class="flex shrink-0 flex-col gap-2 px-3 pt-2 pb-[calc(var(--safe-area-inset-bottom,0px)+0.5rem)]"
  >
    {#if composing}
      <form
        class="flex gap-2"
        onsubmit={(event) => {
          event.preventDefault();
          commitText();
        }}
      >
        <input
          bind:this={draftInput}
          bind:value={draft}
          maxlength="80"
          class="min-w-0 flex-1 rounded-lg bg-white/15 px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          placeholder={m.reels_editor_text_placeholder()}
          aria-label={m.reels_editor_text_label()}
        />
        <button
          type="submit"
          class="inline-flex items-center gap-2 rounded-lg bg-white/15 px-4 py-2 text-sm font-semibold outline-none hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          {m.reels_editor_text_done()}
        </button>
      </form>
    {:else if trayOpen}
      <div class="flex gap-1 overflow-x-auto" role="group" aria-label={m.reels_editor_tool_emoji()}>
        {#each shelf as emoji (emoji)}
          <button
            type="button"
            class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-amber-500"
            aria-label={m.reels_editor_emoji_add({ emoji })}
            onclick={() => addEmoji(emoji)}
          >
            <img src={emojiSvgSrc(emoji) ?? ''} alt="" draggable="false" class="h-7 w-7" />
          </button>
        {/each}
        <button
          type="button"
          class="inline-flex h-11 shrink-0 items-center justify-center rounded-lg px-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-amber-500 {gridOpen
            ? 'bg-white/25'
            : 'hover:bg-white/15'}"
          aria-pressed={gridOpen}
          onclick={() => (gridOpen = !gridOpen)}
          data-reel-emoji-all
        >
          {m.reels_editor_emoji_all()}
        </button>
      </div>
      {#if gridOpen}
        <!-- The chat's own picker body (categories, search, skin tone), on a surface of its own. -->
        <div
          class="bg-cn-surface text-cn-ink flex h-64 min-h-0 flex-col overflow-hidden rounded-2xl"
          data-reel-emoji-grid
        >
          <EmojiGrid onPick={(emoji) => addEmoji(emoji)} />
        </div>
      {/if}
    {/if}

    {#if textToolsVisible}
      <div class="flex items-center gap-1" role="group" aria-label={m.reels_editor_text_style()}>
        {#each TEXT_FONTS as face (face)}
          <button
            type="button"
            class="inline-flex h-9 min-w-11 items-center justify-center rounded-lg px-2 text-base font-bold outline-none focus-visible:ring-2 focus-visible:ring-amber-500 {font ===
            face
              ? 'bg-white/25'
              : 'hover:bg-white/15'}"
            style={`font-family:${fontStack(face, 'inherit')}`}
            aria-label={fontLabels[face]()}
            aria-pressed={font === face}
            title={fontLabels[face]()}
            onclick={() => pickStyle({ font: face })}
            data-reel-font={face}>Aa</button
          >
        {/each}
        <button
          type="button"
          class="inline-flex h-9 min-w-11 items-center justify-center rounded-lg px-2 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 {background ===
          'pill'
            ? 'bg-white/25'
            : 'hover:bg-white/15'}"
          aria-label={m.reels_editor_text_pill()}
          aria-pressed={background === 'pill'}
          title={m.reels_editor_text_pill()}
          onclick={() => pickStyle({ background: background === 'pill' ? 'none' : 'pill' })}
          data-reel-pill
        >
          <RectangleHorizontal size={20} strokeWidth={2.25} />
        </button>
      </div>
    {/if}

    {#if colorToolsVisible}
      <div class="flex items-center gap-2" role="group" aria-label={m.reels_editor_tool_color()}>
        {#each colors as swatch (swatch)}
          <button
            type="button"
            class="h-8 w-8 rounded-full border-2 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 {color ===
            swatch
              ? 'border-white'
              : 'border-white/30'}"
            style={`background:${swatch}`}
            aria-label={m.reels_editor_color({ color: swatch })}
            aria-pressed={color === swatch}
            onclick={() => pickColor(swatch)}
          ></button>
        {/each}
      </div>
    {/if}

    {#if mode === 'draw'}
      <div class="flex items-center gap-2" role="group" aria-label={m.reels_editor_tool_width()}>
        {#each STROKE_WIDTHS as width, index (width)}
          <button
            type="button"
            class="inline-flex h-9 w-11 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500 {penWidth ===
            width
              ? 'bg-white/25'
              : 'hover:bg-white/15'}"
            aria-label={widthLabels[index]()}
            aria-pressed={penWidth === width}
            title={widthLabels[index]()}
            onclick={() => pickWidth(width)}
            data-reel-width={index}
          >
            <span class="block w-6 rounded-full bg-white" style={`height:${width * 60}rem`}></span>
          </button>
        {/each}
      </div>
    {/if}

    {#if error}<p role="alert" class="text-sm text-red-300">{m.reels_editor_error()}</p>{/if}

    <div class="flex items-center justify-center gap-3">
      <button
        type="button"
        class="{toolClass} hover:bg-white/15"
        aria-label={m.reels_editor_tool_text()}
        title={m.reels_editor_tool_text()}
        onclick={openText}
        data-reel-tool-text
      >
        <Type size={22} strokeWidth={2.25} />
      </button>
      <button
        type="button"
        class="{toolClass} {trayOpen ? 'bg-white/25' : 'hover:bg-white/15'}"
        aria-label={m.reels_editor_tool_emoji()}
        aria-pressed={trayOpen}
        title={m.reels_editor_tool_emoji()}
        onclick={() => {
          trayOpen = !trayOpen;
          gridOpen = false;
          if (trayOpen) recents = getRecentEmojis();
          composing = null;
          mode = 'arrange';
        }}
        data-reel-tool-emoji
      >
        <Smile size={22} strokeWidth={2.25} />
      </button>
      <button
        type="button"
        class="{toolClass} {mode === 'draw' ? 'bg-white/25' : 'hover:bg-white/15'}"
        aria-label={m.reels_editor_tool_draw()}
        aria-pressed={mode === 'draw'}
        title={m.reels_editor_tool_draw()}
        onclick={() => toggleMode('draw')}
        data-reel-tool-draw
      >
        <Pencil size={22} strokeWidth={2.25} />
      </button>
      <button
        type="button"
        class="{toolClass} {mode === 'erase' ? 'bg-white/25' : 'hover:bg-white/15'}"
        aria-label={m.reels_editor_tool_erase()}
        aria-pressed={mode === 'erase'}
        title={m.reels_editor_tool_erase()}
        onclick={() => toggleMode('erase')}
        data-reel-tool-erase
      >
        <Eraser size={22} strokeWidth={2.25} />
      </button>
      <button
        type="button"
        class="{toolClass} hover:bg-white/15 disabled:opacity-40"
        aria-label={m.reels_editor_undo()}
        title={m.reels_editor_undo()}
        disabled={history.length === 0}
        onclick={undo}
        data-reel-tool-undo
      >
        <Undo2 size={22} strokeWidth={2.25} />
      </button>
      <button
        type="button"
        class="{toolClass} hover:bg-white/15 disabled:opacity-40"
        aria-label={m.reels_editor_clear()}
        title={m.reels_editor_clear()}
        disabled={overlays.length === 0}
        onclick={clearAll}
        data-reel-tool-clear
      >
        <Trash2 size={22} strokeWidth={2.25} />
      </button>
    </div>
  </div>
</div>
