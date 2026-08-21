<script lang="ts">
  import { m } from '$lib/paraglide/messages';

  /**
   * Square logo export: drag the photo to reposition it under a fixed, resizable crop square,
   * with a separate zoom control - what is inside the white square when you confirm is exactly
   * what gets exported.
   */
  interface Props {
    /** Called with the exported 512×512 blob when the user confirms the crop. */
    onExport: (blob: Blob) => void;
    /** Called when the user clicks Cancel. Omit to hide the cancel button. */
    onCancel?: () => void;
    /**
     * Export format. `'jpeg'` (default, association logos - always opaque) or `'png'` to
     * preserve transparency, e.g. a partner brand icon with a transparent background:
     * flattening it to JPEG turns every transparent pixel black (canvas has no alpha to give
     * a JPEG encoder, so it reads the cleared `rgba(0,0,0,0)` backing as opaque black).
     */
    outputFormat?: 'jpeg' | 'png';
  }

  let { onExport, onCancel, outputFormat = 'jpeg' }: Props = $props();

  const OUT = 512;
  const VIEWPORT_W = 440;
  const VIEWPORT_H = 300;
  const MIN_BOX = 60;
  const MAX_ZOOM = 3;

  let pickedName = $state('');
  let imgEl = $state<HTMLImageElement | undefined>();
  let objectUrl = $state<string | null>(null);
  let loaded = $state(false);
  let naturalW = $state(0);
  let naturalH = $state(0);

  let zoom = $state(1);
  /** Crop square's side length in viewport pixels; the square itself always stays centered. */
  let boxSize = $state(180);
  /** Pan of the displayed photo, in viewport pixels, relative to centered. */
  let offsetX = $state(0);
  let offsetY = $state(0);

  function revoke() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    imgEl = undefined;
    loaded = false;
  }

  function onPickFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    revoke();
    if (!file || !file.type.startsWith('image/')) return;
    pickedName = file.name;
    objectUrl = URL.createObjectURL(file);
    input.value = '';
  }

  function handleImageLoad() {
    if (!imgEl) return;
    naturalW = imgEl.naturalWidth;
    naturalH = imgEl.naturalHeight;
    zoom = 1;
    boxSize = Math.max(MIN_BOX, Math.min(VIEWPORT_W, VIEWPORT_H) * 0.65);
    offsetX = 0;
    offsetY = 0;
    loaded = true;
  }

  /** How the photo is currently laid out in the viewport: covers it at zoom 1, scales up from there. */
  function computeGeometry() {
    const coverScale = Math.max(VIEWPORT_W / naturalW, VIEWPORT_H / naturalH);
    const scale = coverScale * zoom;
    const displayW = naturalW * scale;
    const displayH = naturalH * scale;
    return {
      scale,
      displayW,
      displayH,
      centeredLeft: (VIEWPORT_W - displayW) / 2,
      centeredTop: (VIEWPORT_H - displayH) / 2,
      boxLeft: (VIEWPORT_W - boxSize) / 2,
      boxTop: (VIEWPORT_H - boxSize) / 2,
    };
  }

  let geo = $derived(loaded ? computeGeometry() : null);
  let imageLeft = $derived(geo ? geo.centeredLeft + offsetX : 0);
  let imageTop = $derived(geo ? geo.centeredTop + offsetY : 0);

  /** Keeps the crop square fully over the photo - never panned/zoomed/resized to show blank space. */
  function clampOffsets() {
    const g = computeGeometry();
    const maxX = g.boxLeft - g.centeredLeft;
    const minX = g.boxLeft + boxSize - g.displayW - g.centeredLeft;
    const maxY = g.boxTop - g.centeredTop;
    const minY = g.boxTop + boxSize - g.displayH - g.centeredTop;
    const [lowX, highX] = minX <= maxX ? [minX, maxX] : [maxX, minX];
    const [lowY, highY] = minY <= maxY ? [minY, maxY] : [maxY, minY];
    offsetX = Math.min(Math.max(offsetX, lowX), highX);
    offsetY = Math.min(Math.max(offsetY, lowY), highY);
  }

  let panFrom: { x: number; y: number; ox: number; oy: number } | null = null;

  function onImagePointerDown(e: PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    panFrom = { x: e.clientX, y: e.clientY, ox: offsetX, oy: offsetY };
  }
  function onImagePointerMove(e: PointerEvent) {
    if (!panFrom) return;
    offsetX = panFrom.ox + (e.clientX - panFrom.x);
    offsetY = panFrom.oy + (e.clientY - panFrom.y);
    clampOffsets();
  }
  function onImagePointerUp() {
    panFrom = null;
  }

  let resizeFrom: { x: number; y: number; size: number } | null = null;

  function onHandlePointerDown(e: PointerEvent) {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resizeFrom = { x: e.clientX, y: e.clientY, size: boxSize };
  }
  function onHandlePointerMove(e: PointerEvent) {
    if (!resizeFrom) return;
    // Growth is symmetric around the centered box, so moving the corner by `delta` grows the
    // full side by `2 * delta`.
    const delta = (e.clientX - resizeFrom.x + (e.clientY - resizeFrom.y)) / 2;
    boxSize = Math.min(
      Math.max(resizeFrom.size + delta * 2, MIN_BOX),
      Math.min(VIEWPORT_W, VIEWPORT_H)
    );
    clampOffsets();
  }
  function onHandlePointerUp() {
    resizeFrom = null;
  }

  function onZoomInput(e: Event) {
    zoom = Number((e.target as HTMLInputElement).value);
    clampOffsets();
  }

  function exportBlob() {
    if (!imgEl || !loaded) return;
    const g = computeGeometry();
    const left = g.centeredLeft + offsetX;
    const top = g.centeredTop + offsetY;
    const srcX = (g.boxLeft - left) / g.scale;
    const srcY = (g.boxTop - top) / g.scale;
    const srcSize = boxSize / g.scale;

    const canvas = document.createElement('canvas');
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (outputFormat !== 'png') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, OUT, OUT);
    }
    ctx.drawImage(imgEl, srcX, srcY, srcSize, srcSize, 0, 0, OUT, OUT);
    canvas.toBlob(
      (b) => {
        if (b) onExport(b);
      },
      outputFormat === 'png' ? 'image/png' : 'image/jpeg',
      outputFormat === 'png' ? undefined : 0.92
    );
  }
</script>

<div class="border-cn-border space-y-4 rounded-2xl border bg-(--cn-surface)/60 p-4">
  <div class="flex flex-wrap items-center gap-3">
    <input
      type="file"
      accept="image/jpeg,image/png,image/webp"
      onchange={onPickFile}
      class="text-text-main file:bg-cn-yellow file:text-cn-dark text-sm file:mr-2 file:rounded-lg file:border-0 file:px-3 file:py-1.5 file:text-sm file:font-bold"
    />
    {#if pickedName}
      <span class="text-text-muted max-w-[200px] truncate text-xs">{pickedName}</span>
    {/if}
  </div>

  {#if objectUrl}
    <div
      class="relative mx-auto touch-none overflow-hidden rounded-2xl bg-black select-none"
      style="width: {VIEWPORT_W}px; height: {VIEWPORT_H}px; max-width: 100%;"
      role="img"
      aria-label={m.asso_logo_preview_aria()}
      onpointerdown={onImagePointerDown}
      onpointermove={onImagePointerMove}
      onpointerup={onImagePointerUp}
      onpointercancel={onImagePointerUp}
    >
      <img
        bind:this={imgEl}
        src={objectUrl}
        alt=""
        draggable="false"
        onload={handleImageLoad}
        class="pointer-events-none absolute max-w-none"
        style="left: {imageLeft}px; top: {imageTop}px; width: {geo?.displayW ??
          0}px; height: {geo?.displayH ?? 0}px;"
      />
      {#if geo}
        <!-- Dims everything outside the crop square via a huge box-shadow spread, clipped by the
             viewport's own overflow-hidden. -->
        <div
          class="pointer-events-none absolute"
          style="left: {geo.boxLeft}px; top: {geo.boxTop}px; width: {boxSize}px; height: {boxSize}px; box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.55);"
        ></div>
        <div
          class="pointer-events-none absolute border-2 border-white"
          style="left: {geo.boxLeft}px; top: {geo.boxTop}px; width: {boxSize}px; height: {boxSize}px;"
        >
          <div
            class="bg-cn-yellow pointer-events-auto absolute -right-2 -bottom-2 h-5 w-5 cursor-nwse-resize touch-none rounded-full border-2 border-white"
            role="slider"
            aria-label={m.asso_logo_resize_handle_aria()}
            aria-valuenow={Math.round(boxSize)}
            aria-valuemin={MIN_BOX}
            aria-valuemax={Math.min(VIEWPORT_W, VIEWPORT_H)}
            tabindex="0"
            onpointerdown={onHandlePointerDown}
            onpointermove={onHandlePointerMove}
            onpointerup={onHandlePointerUp}
            onpointercancel={onHandlePointerUp}
          ></div>
        </div>
      {/if}
    </div>

    <div class="flex items-center gap-3">
      <label for="assoc-logo-zoom" class="text-text-muted text-xs font-bold tracking-wide uppercase"
        >{m.asso_logo_zoom_label()}</label
      >
      <input
        id="assoc-logo-zoom"
        type="range"
        min="1"
        max={MAX_ZOOM}
        step="0.02"
        value={zoom}
        oninput={onZoomInput}
        class="accent-cn-yellow flex-1"
      />
    </div>

    <div class="flex flex-wrap justify-end gap-2">
      {#if onCancel}
        <button
          type="button"
          onclick={() => {
            revoke();
            onCancel();
          }}
          class="text-text-muted hover:text-text-main rounded-xl px-4 py-2 text-sm font-semibold"
        >
          {m.common_cancel_button()}
        </button>
      {/if}
      <button
        type="button"
        onclick={exportBlob}
        disabled={!loaded}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
      >
        {m.asso_logo_use_image_button()}
      </button>
    </div>
  {:else}
    <p class="text-text-muted text-sm">{m.asso_logo_pick_hint()}</p>
  {/if}
</div>
