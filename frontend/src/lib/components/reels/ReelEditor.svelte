<script lang="ts">
  /** The post-capture editor: decorations are baked into the file before it reaches the server. */
  import { onDestroy } from 'svelte';
  import { Check, ChevronLeft, Eraser, Palette, Pencil, Type } from '@lucide/svelte';
  import type { ReelClip } from '$lib/reels/reelCapture';
  import {
    renderEditedReelMedia,
    type ReelEdits,
    type ReelPoint,
    type ReelStroke,
    type ReelText,
  } from '$lib/reels/reelEditor';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    clip: ReelClip;
    oncancel: () => void;
    onapply: (blob: Blob) => void;
  }

  let { clip, oncancel, onapply }: Props = $props();
  let canvas = $state<HTMLCanvasElement | null>(null);
  let stage = $state<HTMLElement | null>(null);
  let text = $state('');
  let color = $state('#ffffff');
  let drawing = $state(false);
  let busy = $state(false);
  let error = $state(false);
  let strokes = $state<ReelStroke[]>([]);
  let texts = $state<ReelText[]>([]);
  let current: ReelPoint[] = [];

  const colors = ['#ffffff', '#050505', '#ffcf33', '#f05b5b', '#5bd0f0'];
  const source = $derived(URL.createObjectURL(clip.blob));

  onDestroy(() => URL.revokeObjectURL(source));

  function point(event: PointerEvent): ReelPoint | null {
    if (!stage) return null;
    const bounds = stage.getBoundingClientRect();
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
    context.lineWidth = 4;
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

  function addText() {
    const value = text.trim();
    if (!value) return;
    texts = [...texts, { text: value, color, size: 0.055, x: 0.5, y: 0.5 }];
    text = '';
  }

  function clearDrawing() {
    strokes = [];
    texts = [];
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }

  async function apply() {
    busy = true;
    error = false;
    const edits: ReelEdits = { strokes, texts };
    try {
      const fontFamily = stage ? getComputedStyle(stage).fontFamily : 'Nunito Variable, sans-serif';
      const edited = await renderEditedReelMedia(clip.blob, edits, fontFamily);
      onapply(edited.blob);
    } catch (cause) {
      console.error('[reel-editor] export failed', cause);
      error = true;
      busy = false;
    }
  }
</script>

<div class="absolute inset-0 z-20 flex flex-col bg-black text-white" data-reel-editor>
  <header
    class="flex items-center justify-between px-3 pt-[calc(var(--safe-area-inset-top,0px)+0.75rem)] pb-3"
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
    <h1 class="text-base font-bold">{m.reels_editor_title()}</h1>
    <button
      type="button"
      class="ui-icon-button"
      aria-label={m.reels_editor_clear()}
      title={m.reels_editor_clear()}
      onclick={clearDrawing}
    >
      <Eraser size={21} strokeWidth={2.25} />
    </button>
  </header>

  <div bind:this={stage} class="relative min-h-0 flex-1 overflow-hidden">
    {#if clip.blob.type.startsWith('image/')}
      <img src={source} alt="" class="h-full w-full object-contain" />
    {:else}
      <video src={source} autoplay muted loop playsinline class="h-full w-full object-contain"
      ></video>
    {/if}
    <canvas
      bind:this={canvas}
      width="1000"
      height="1000"
      class="absolute inset-0 h-full w-full touch-none"
      onpointerdown={startDrawing}
      onpointermove={draw}
      onpointerup={stopDrawing}
      onpointercancel={stopDrawing}
    ></canvas>
    {#each texts as item, index (index)}
      <span
        class="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 font-bold drop-shadow-[0_1px_2px_black]"
        style={`left:${item.x * 100}%;top:${item.y * 100}%;color:${item.color};font-size:${item.size * 100}cqh`}
        >{item.text}</span
      >
    {/each}
  </div>

  <div class="flex flex-col gap-3 px-4 pt-3 pb-[calc(var(--safe-area-inset-bottom,0px)+0.75rem)]">
    <div class="flex items-center gap-2">
      <Palette size={18} strokeWidth={2.25} />
      {#each colors as swatch (swatch)}
        <button
          type="button"
          class="h-7 w-7 rounded-full border-2 border-white/70"
          style={`background:${swatch}`}
          aria-label={m.reels_editor_color({ color: swatch })}
          aria-pressed={color === swatch}
          onclick={() => (color = swatch)}
        ></button>
      {/each}
    </div>
    <div class="flex gap-2">
      <input
        bind:value={text}
        class="min-w-0 flex-1 rounded-lg bg-white/15 px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        placeholder={m.reels_editor_text_placeholder()}
        aria-label={m.reels_editor_text_label()}
      />
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-lg bg-white/15 px-3 py-2 text-sm font-semibold outline-none hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-amber-500"
        onclick={addText}
      >
        <Type size={17} strokeWidth={2.25} />
        {m.reels_editor_add_text()}
      </button>
    </div>
    {#if error}<p role="alert" class="text-sm text-red-300">{m.reels_editor_error()}</p>{/if}
    <button
      type="button"
      class="text-cn-ink inline-flex items-center justify-center gap-2 rounded-lg bg-amber-500 px-4 py-3 text-sm font-bold outline-none hover:bg-amber-400 focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50"
      disabled={busy}
      onclick={apply}
    >
      {#if busy}<Pencil size={18} class="animate-pulse" />{:else}<Check
          size={18}
          strokeWidth={2.5}
        />{/if}
      {busy ? m.reels_editor_exporting() : m.reels_editor_apply()}
    </button>
  </div>
</div>
