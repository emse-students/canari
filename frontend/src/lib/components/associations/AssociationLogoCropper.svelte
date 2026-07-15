<script lang="ts">
  import { tick } from 'svelte';
  import { m } from '$lib/paraglide/messages';

  /**
   * Square logo export for associations: center crop with zoom, or letterbox on white.
   */
  interface Props {
    /** Called with the exported 512×512 JPEG blob when the user confirms the crop. */
    onExport: (blob: Blob) => void;
    /** Called when the user clicks Cancel. Omit to hide the cancel button. */
    onCancel?: () => void;
  }

  let { onExport, onCancel }: Props = $props();

  const OUT = 512;

  let mode = $state<'cover' | 'pad'>('cover');
  /** Zoom-in for cover mode (1 = max visible square, higher = tighter crop). */
  let zoom = $state(1);
  let pickedName = $state('');
  let imgEl = $state<HTMLImageElement | null>(null);
  let objectUrl = $state<string | null>(null);
  let previewCanvas = $state<HTMLCanvasElement | undefined>();

  function revoke() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    imgEl = null;
  }

  function onPickFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    revoke();
    if (!file || !file.type.startsWith('image/')) return;
    pickedName = file.name;
    objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      imgEl = img;
    };
    img.src = objectUrl;
    input.value = '';
  }

  function drawToCanvas(target: HTMLCanvasElement, size: number) {
    const ctx = target.getContext('2d');
    if (!ctx || !imgEl) return;
    target.width = size;
    target.height = size;
    const nw = imgEl.naturalWidth;
    const nh = imgEl.naturalHeight;
    if (nw < 1 || nh < 1) return;

    if (mode === 'pad') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      const scale = Math.min(size / nw, size / nh);
      const dw = nw * scale;
      const dh = nh * scale;
      ctx.drawImage(imgEl, (size - dw) / 2, (size - dh) / 2, dw, dh);
    } else {
      const z = Math.min(Math.max(zoom, 1), 3);
      let side = Math.min(nw, nh) / z;
      side = Math.min(side, nw, nh);
      const sx = (nw - side) / 2;
      const sy = (nh - side) / 2;
      ctx.drawImage(imgEl, sx, sy, side, side, 0, 0, size, size);
    }
  }

  function drawPreview() {
    const c = previewCanvas;
    if (!c || !imgEl) return;
    drawToCanvas(c, 240);
  }

  $effect(() => {
    void mode;
    void zoom;
    void imgEl;
    void previewCanvas;
    if (!imgEl || !previewCanvas) return;
    void tick().then(drawPreview);
  });

  function exportBlob() {
    const canvas = document.createElement('canvas');
    drawToCanvas(canvas, OUT);
    canvas.toBlob(
      (b) => {
        if (b) onExport(b);
      },
      'image/jpeg',
      0.92
    );
  }
</script>

<div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/60 p-4 space-y-4">
  <div class="flex flex-wrap gap-3 items-center">
    <input
      type="file"
      accept="image/jpeg,image/png,image/webp"
      onchange={onPickFile}
      class="text-sm text-text-main file:mr-2 file:rounded-lg file:border-0 file:bg-cn-yellow file:px-3 file:py-1.5 file:text-sm file:font-bold file:text-cn-dark"
    />
    {#if pickedName}
      <span class="text-xs text-text-muted truncate max-w-[200px]">{pickedName}</span>
    {/if}
  </div>

  {#if imgEl}
    <div class="flex flex-wrap gap-4 items-start">
      <div class="space-y-2">
        <p class="text-xs font-bold uppercase tracking-wide text-text-muted">
          {m.asso_logo_mode_label()}
        </p>
        <div class="flex gap-2">
          <button
            type="button"
            onclick={() => (mode = 'cover')}
            class="rounded-xl px-3 py-1.5 text-sm font-semibold border transition-colors {mode ===
            'cover'
              ? 'border-cn-yellow bg-cn-yellow/15 text-text-main'
              : 'border-cn-border text-text-muted hover:text-text-main'}"
          >
            {m.asso_logo_cover_button()}
          </button>
          <button
            type="button"
            onclick={() => (mode = 'pad')}
            class="rounded-xl px-3 py-1.5 text-sm font-semibold border transition-colors {mode ===
            'pad'
              ? 'border-cn-yellow bg-cn-yellow/15 text-text-main'
              : 'border-cn-border text-text-muted hover:text-text-main'}"
          >
            {m.asso_logo_pad_button()}
          </button>
        </div>
      </div>
      {#if mode === 'cover'}
        <div class="flex-1 min-w-[180px] space-y-1">
          <label
            for="assoc-logo-zoom"
            class="text-xs font-bold uppercase tracking-wide text-text-muted"
            >{m.asso_logo_zoom_label()}</label
          >
          <input
            id="assoc-logo-zoom"
            type="range"
            min="1"
            max="3"
            step="0.05"
            value={zoom}
            oninput={(e) => (zoom = Number((e.target as HTMLInputElement).value))}
            class="w-full accent-cn-yellow"
          />
        </div>
      {/if}
    </div>

    <div class="flex justify-center">
      <canvas
        bind:this={previewCanvas}
        width={240}
        height={240}
        class="rounded-2xl border border-cn-border bg-white shadow-inner max-w-full"
        aria-label={m.asso_logo_preview_aria()}
      ></canvas>
    </div>

    <div class="flex flex-wrap gap-2 justify-end">
      {#if onCancel}
        <button
          type="button"
          onclick={() => {
            revoke();
            onCancel();
          }}
          class="rounded-xl px-4 py-2 text-sm font-semibold text-text-muted hover:text-text-main"
        >
          {m.common_cancel_button()}
        </button>
      {/if}
      <button
        type="button"
        onclick={exportBlob}
        class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover"
      >
        {m.asso_logo_use_image_button()}
      </button>
    </div>
  {:else}
    <p class="text-sm text-text-muted">{m.asso_logo_pick_hint()}</p>
  {/if}
</div>
