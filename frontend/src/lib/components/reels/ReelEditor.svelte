<script lang="ts">
  /**
   * The post-capture editor (CanaReels, docs/wiki/frontend/modules/reel-editor.md): text and emoji
   * the member places, moves, pinches, twists and drops on a trash zone, plus a freehand pen. What
   * is drawn here is baked into the file by `renderEditedReelMedia`.
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
  import { Check, ChevronLeft, Eraser, Pencil, Smile, Trash2, Type } from '@lucide/svelte';
  import { TAP_SLOP_PX, TransformGesture, pointInRect } from '$lib/gestures/transformGesture';
  import type { ReelClip } from '$lib/reels/reelCapture';
  import { renderEditedReelMedia, type ReelPoint, type ReelStroke } from '$lib/reels/reelEditor';
  import {
    EMOJI_BASE_SIZE,
    QUICK_EMOJI,
    TEXT_BASE_SIZE,
    broughtToFront,
    createEmojiOverlay,
    createTextOverlay,
    withTextEdit,
    withTransform,
    withoutOverlay,
    type ReelOverlay,
  } from '$lib/reels/reelOverlays';
  import { emojiSvgSrc } from '$lib/utils/emojiSvg';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    clip: ReelClip;
    oncancel: () => void;
    onapply: (blob: Blob) => void;
  }

  let { clip, oncancel, onapply }: Props = $props();
  let canvas = $state<HTMLCanvasElement | null>(null);
  let frame = $state<HTMLElement | null>(null);
  let trash = $state<HTMLElement | null>(null);
  let draftInput = $state<HTMLInputElement | null>(null);
  let color = $state('#ffffff');
  let busy = $state(false);
  let error = $state(false);
  let strokes = $state<ReelStroke[]>([]);
  let overlays = $state<ReelOverlay[]>([]);
  let selectedId = $state<string | null>(null);
  let mode = $state<'arrange' | 'draw'>('arrange');
  let trayOpen = $state(false);
  /** The text field is open: for a new text (`id` null) or to reword the one with that id. */
  let composing = $state<{ id: string | null } | null>(null);
  let draft = $state('');
  let dragging = $state(false);
  let overTrash = $state(false);
  /** The media's width / height, known once it has loaded; the frame takes this shape. */
  let ratio = $state(9 / 16);
  let drawing = false;
  let current: ReelPoint[] = [];

  const colors = ['#ffffff', '#050505', '#ffcf33', '#f05b5b', '#5bd0f0'];
  const source = $derived(URL.createObjectURL(clip.blob));
  const isImage = $derived(clip.blob.type.startsWith('image/'));
  const selected = $derived(overlays.find((overlay) => overlay.id === selectedId) ?? null);
  const colorToolsVisible = $derived(
    mode === 'draw' || composing !== null || selected?.kind === 'text'
  );

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
      overlays = broughtToFront(overlays, hit);
      const handled = overlays.find((overlay) => overlay.id === hit)!;
      // The swatches show (and a reword keeps) the colour of the text in hand.
      if (handled.kind === 'text') color = handled.color;
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
        composing = { id };
      }
    }
    dragging = false;
    overTrash = false;
  }

  function point(event: PointerEvent): ReelPoint | null {
    if (!frame) return null;
    const bounds = frame.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  }

  function draw(event: PointerEvent) {
    if (!drawing) return;
    const next = point(event);
    if (next) current.push(next);
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context || current.length < 2) return;
    const previous = current[current.length - 2];
    context.strokeStyle = color;
    context.lineWidth = 0.006 * Math.min(canvas.width, canvas.height);
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(previous.x * canvas.width, previous.y * canvas.height);
    context.lineTo(next!.x * canvas.width, next!.y * canvas.height);
    context.stroke();
  }

  function startDrawing(event: PointerEvent) {
    const next = point(event);
    if (!next || !canvas) return;
    drawing = true;
    current = [next];
    canvas.setPointerCapture(event.pointerId);
  }

  function stopDrawing() {
    if (!drawing) return;
    drawing = false;
    if (current.length > 1) strokes = [...strokes, { color, width: 0.006, points: current }];
    current = [];
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
      overlays = withTextEdit(overlays, composing.id, { text: draft, color });
    } else {
      const created = createTextOverlay(draft, color);
      if (created) {
        overlays = [...overlays, created];
        selectedId = created.id;
      }
    }
    composing = null;
    draft = '';
  }

  function addEmoji(emoji: string) {
    const created = createEmojiOverlay(emoji);
    overlays = [...overlays, created];
    selectedId = created.id;
    trayOpen = false;
    mode = 'arrange';
  }

  function pickColor(swatch: string) {
    color = swatch;
    if (selected?.kind === 'text')
      overlays = withTextEdit(overlays, selected.id, { color: swatch });
  }

  function toggleDraw() {
    mode = mode === 'draw' ? 'arrange' : 'draw';
    trayOpen = false;
    composing = null;
    selectedId = null;
  }

  function clearAll() {
    strokes = [];
    overlays = [];
    selectedId = null;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }

  async function apply() {
    if (strokes.length === 0 && overlays.length === 0) {
      console.debug('[reel-editor] nothing was added: back to the take as it was');
      oncancel();
      return;
    }
    busy = true;
    error = false;
    selectedId = null;
    try {
      const fontFamily = frame ? getComputedStyle(frame).fontFamily : 'Nunito Variable, sans-serif';
      const edited = await renderEditedReelMedia(clip.blob, { strokes, overlays }, fontFamily);
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
    <h1 class="min-w-0 truncate text-base font-bold">{m.reels_editor_title()}</h1>
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
      onpointerdown={arrangeDown}
      onpointermove={arrangeMove}
      onpointerup={arrangeUp}
      onpointercancel={arrangeUp}
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
      <canvas
        bind:this={canvas}
        width="1000"
        height={Math.round(1000 / ratio)}
        class="absolute inset-0 h-full w-full touch-none {mode === 'draw'
          ? ''
          : 'pointer-events-none'}"
        onpointerdown={startDrawing}
        onpointermove={draw}
        onpointerup={stopDrawing}
        onpointercancel={stopDrawing}
      ></canvas>
      {#each overlays as overlay (overlay.id)}
        {@const picked = overlay.id === selectedId}
        <div
          data-overlay-id={overlay.id}
          data-overlay-kind={overlay.kind}
          data-overlay-scale={overlay.scale.toFixed(3)}
          class="absolute p-2 {mode === 'draw' ? 'pointer-events-none' : ''} {picked
            ? 'outline-2 outline-white/80 outline-dashed'
            : ''} rounded-lg"
          style={`left:${overlay.x * 100}%;top:${overlay.y * 100}%;transform:translate(-50%,-50%) rotate(${overlay.rotation}rad)`}
        >
          {#if overlay.kind === 'text'}
            <span
              class="block font-bold whitespace-nowrap drop-shadow-[0_1px_3px_rgb(0_0_0/0.6)]"
              style={`color:${overlay.color};font-size:${TEXT_BASE_SIZE * overlay.scale * 100}cqmin;line-height:1.2`}
              >{overlay.text}</span
            >
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
        {#each QUICK_EMOJI as emoji (emoji)}
          <button
            type="button"
            class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-amber-500"
            aria-label={m.reels_editor_emoji_add({ emoji })}
            onclick={() => addEmoji(emoji)}
          >
            <img src={emojiSvgSrc(emoji) ?? ''} alt="" draggable="false" class="h-7 w-7" />
          </button>
        {/each}
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
        onclick={toggleDraw}
        data-reel-tool-draw
      >
        <Pencil size={22} strokeWidth={2.25} />
      </button>
      <button
        type="button"
        class="{toolClass} hover:bg-white/15"
        aria-label={m.reels_editor_clear()}
        title={m.reels_editor_clear()}
        onclick={clearAll}
      >
        <Eraser size={22} strokeWidth={2.25} />
      </button>
    </div>
  </div>
</div>
