<script lang="ts">
  import { clickOutside } from '$lib/actions/clickOutside';

  /** Converts a 7-char hex string to HSV (h: 0-360, s: 0-1, v: 0-1). */
  function hexToHsv(hex: string): [number, number, number] {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = Math.round(h * 60);
      if (h < 0) h += 360;
    }
    return [h, max === 0 ? 0 : d / max, max];
  }

  /** Converts HSV to a 7-char hex string. */
  function hsvToHex(h: number, s: number, v: number): string {
    const f = (n: number) => {
      const k = (n + h / 60) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    const toHex = (x: number) =>
      Math.round(Math.max(0, Math.min(1, x)) * 255)
        .toString(16)
        .padStart(2, '0');
    return `#${toHex(f(5))}${toHex(f(3))}${toHex(f(1))}`;
  }

  let {
    value = $bindable('#3b82f6'),
    label = undefined,
    class: className = '',
  }: { value?: string; label?: string; class?: string } = $props();

  // Initialise HSV from the incoming value; track the last value we emitted
  // to avoid re-parsing on our own updates (prevents floating-point drift loops).
  const [ih, is, iv] = hexToHsv(value.startsWith('#') && value.length === 7 ? value : '#3b82f6');
  let h = $state(ih);
  let s = $state(is);
  let v = $state(iv);
  let lastEmitted = value; // plain variable - intentionally not reactive

  $effect(() => {
    // Only re-parse when an external update changes value
    if (value !== lastEmitted) {
      const safe = value.startsWith('#') && value.length === 7 ? value : '#3b82f6';
      const [nh, ns, nv] = hexToHsv(safe);
      h = nh;
      s = ns;
      v = nv;
      hexInput = safe;
      lastEmitted = value;
    }
  });

  function emit() {
    const hex = hsvToHex(h, s, v);
    lastEmitted = hex;
    value = hex;
    hexInput = hex;
  }

  // ── Hex input ─────────────────────────────────────────────────────
  let hexInput = $state(value);

  function onHexInput(e: Event) {
    const raw = (e.target as HTMLInputElement).value;
    hexInput = raw;
    const cleaned = raw.startsWith('#') ? raw : `#${raw}`;
    if (/^#[0-9a-fA-F]{6}$/.test(cleaned)) {
      const [nh, ns, nv] = hexToHsv(cleaned);
      h = nh;
      s = ns;
      v = nv;
      lastEmitted = cleaned;
      value = cleaned;
    }
  }

  // ── 2-D saturation/value picker ───────────────────────────────────
  let pickerEl = $state<HTMLDivElement | null>(null);
  let draggingSv = $state(false);

  function pickSv(e: MouseEvent | TouchEvent) {
    if (!pickerEl) return;
    const rect = pickerEl.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    s = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    v = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
    emit();
  }

  function startSvDrag(e: MouseEvent | TouchEvent) {
    draggingSv = true;
    pickSv(e);
  }

  function onWindowMouseMove(e: MouseEvent) {
    if (draggingSv) pickSv(e);
    if (draggingHue) pickHue(e);
  }

  function onWindowMouseUp() {
    draggingSv = false;
    draggingHue = false;
  }

  // ── Hue slider drag ───────────────────────────────────────────────
  let hueEl = $state<HTMLDivElement | null>(null);
  let draggingHue = $state(false);

  function pickHue(e: MouseEvent | TouchEvent) {
    if (!hueEl) return;
    const rect = hueEl.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    h = Math.round(Math.max(0, Math.min(360, ((clientX - rect.left) / rect.width) * 360)));
    emit();
  }

  function startHueDrag(e: MouseEvent | TouchEvent) {
    draggingHue = true;
    pickHue(e);
  }

  // ── Popover ───────────────────────────────────────────────────────
  let open = $state(false);

  // Preset swatches for quick picks
  const PRESETS = [
    '#122035',
    '#1e3a5f',
    '#0f4c81',
    '#1565c0',
    '#0d47a1',
    '#1a237e',
    '#4527a0',
    '#6a1b9a',
    '#880e4f',
    '#b71c1c',
    '#bf360c',
    '#e65100',
    '#f57f17',
    '#f9a825',
    '#f5c518',
    '#33691e',
    '#1b5e20',
    '#004d40',
    '#006064',
    '#01579b',
    '#37474f',
    '#546e7a',
    '#607d8b',
    '#9e9e9e',
    '#ffffff',
  ];
</script>

<svelte:window
  onmousemove={onWindowMouseMove}
  onmouseup={onWindowMouseUp}
  ontouchmove={(e) => {
    if (draggingSv) {
      e.preventDefault();
      pickSv(e);
    }
    if (draggingHue) {
      e.preventDefault();
      pickHue(e);
    }
  }}
  ontouchend={() => {
    draggingSv = false;
    draggingHue = false;
  }}
/>

<div class="relative inline-block {className}" use:clickOutside={() => (open = false)}>
  <!-- Trigger swatch button -->
  <button
    type="button"
    onclick={() => (open = !open)}
    class="h-7 w-12 rounded-lg border-2 border-cn-border shadow-sm transition-all hover:scale-105 active:scale-95 hover:border-cn-dark focus:outline-none focus:ring-2 focus:ring-cn-yellow/60"
    style="background:{value};"
    aria-label={label ?? 'Choisir une couleur'}
    title={label}
  ></button>

  {#if open}
    <div
      class="absolute right-0 top-full mt-1.5 z-50 w-56 rounded-2xl border border-cn-border bg-[var(--cn-surface)] shadow-2xl p-3 space-y-3"
    >
      <!-- 2-D saturation / value area -->
      <div
        bind:this={pickerEl}
        role="presentation"
        class="relative w-full rounded-xl overflow-hidden select-none"
        style="height:120px; background: linear-gradient(to bottom, transparent, #000), linear-gradient(to right, #fff, hsl({h}deg 100% 50%)); cursor:crosshair;"
        onmousedown={startSvDrag}
        ontouchstart={(e) => {
          e.preventDefault();
          startSvDrag(e);
        }}
      >
        <!-- Cursor ring -->
        <div
          class="absolute w-3.5 h-3.5 rounded-full border-2 border-white shadow pointer-events-none"
          style="left:{s * 100}%; top:{(1 - v) *
            100}%; transform:translate(-50%,-50%); box-shadow:0 0 0 1.5px rgba(0,0,0,0.3), 0 1px 4px rgba(0,0,0,0.4);"
        ></div>
      </div>

      <!-- Hue slider -->
      <div
        bind:this={hueEl}
        role="presentation"
        class="relative w-full rounded-full select-none"
        style="height:14px; background:linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00); cursor:pointer;"
        onmousedown={startHueDrag}
        ontouchstart={(e) => {
          e.preventDefault();
          startHueDrag(e);
        }}
      >
        <!-- Hue thumb -->
        <div
          class="absolute top-1/2 w-4 h-4 rounded-full border-2 border-white pointer-events-none"
          style="left:{(h / 360) *
            100}%; transform:translate(-50%,-50%); box-shadow:0 0 0 1.5px rgba(0,0,0,0.3), 0 1px 3px rgba(0,0,0,0.4);"
        ></div>
      </div>

      <!-- Preview + hex input -->
      <div class="flex items-center gap-2">
        <span
          class="w-7 h-7 rounded-lg shrink-0 border border-cn-border/60"
          style="background:{value};"
        ></span>
        <span class="text-xs text-text-muted font-mono select-none">#</span>
        <input
          type="text"
          value={hexInput.replace(/^#/, '')}
          oninput={(e) => {
            const raw = (e.target as HTMLInputElement).value
              .replace(/[^0-9a-fA-F]/g, '')
              .slice(0, 6);
            (e.target as HTMLInputElement).value = raw;
            onHexInput({ target: { value: '#' + raw } } as unknown as Event);
          }}
          maxlength={6}
          class="flex-1 min-w-0 rounded-lg border border-cn-border bg-cn-bg px-2 py-1 text-xs font-mono text-text-main focus:outline-none focus:ring-1 focus:ring-cn-yellow"
          placeholder="rrggbb"
          spellcheck="false"
        />
      </div>

      <!-- Preset swatches -->
      <div class="grid grid-cols-5 gap-1">
        {#each PRESETS as preset (preset)}
          <button
            type="button"
            onclick={() => {
              value = preset;
              lastEmitted = preset;
              const [nh, ns, nv] = hexToHsv(preset);
              h = nh;
              s = ns;
              v = nv;
              hexInput = preset;
            }}
            class="w-full aspect-square rounded-lg border-2 transition-transform hover:scale-110 active:scale-95"
            style="background:{preset}; border-color:{value === preset
              ? 'var(--cn-dark)'
              : 'transparent'};"
            title={preset}
            aria-label={preset}
          ></button>
        {/each}
      </div>
    </div>
  {/if}
</div>
