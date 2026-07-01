<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import {
    listAggregatedCalendarFeed,
    type AssociationCalendarFeedEvent,
  } from '$lib/associations/api';
  import {
    buildPreviewInnerHtml,
    exportCalendarMonth,
    DEFAULT_EXPORT_OPTIONS,
    CALENDAR_CONTAINER_HEIGHT,
    CALENDAR_CONTAINER_WIDTH,
    fileToDataUrl,
    type CalendarExportOptions,
  } from '$lib/utils/calendarExport';
  import { ChevronLeft, ChevronRight, FileDown, ImagePlus, X, RotateCcw } from '@lucide/svelte';
  import ColorPicker from '$lib/components/ui/ColorPicker.svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  // ── Month navigation ─────────────────────────────────────────────
  let focusDate = $state(new Date());
  let year = $derived(focusDate.getFullYear());
  let month = $derived(focusDate.getMonth());
  let filterAssociationId = $state('');

  const titleMonth = $derived(
    new Intl.DateTimeFormat(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
      month: 'long',
      year: 'numeric',
    }).format(focusDate)
  );

  // ── Events ───────────────────────────────────────────────────────
  let events = $state<AssociationCalendarFeedEvent[]>([]);
  let loading = $state(false);

  async function loadMonth() {
    loading = true;
    try {
      const start = new Date(focusDate.getFullYear(), focusDate.getMonth(), 1, 0, 0, 0, 0);
      const end = new Date(focusDate.getFullYear(), focusDate.getMonth() + 1, 0, 23, 59, 59, 999);
      events = await listAggregatedCalendarFeed({
        from: start.toISOString(),
        to: end.toISOString(),
        associationId: filterAssociationId || undefined,
      });
    } catch {
      events = [];
    } finally {
      loading = false;
    }
  }

  function prevMonth() {
    focusDate = new Date(focusDate.getFullYear(), focusDate.getMonth() - 1, 1);
    void loadMonth();
  }

  function nextMonth() {
    focusDate = new Date(focusDate.getFullYear(), focusDate.getMonth() + 1, 1);
    void loadMonth();
  }

  // ── Export options ───────────────────────────────────────────────
  let opts = $state<Required<CalendarExportOptions>>({
    ...DEFAULT_EXPORT_OPTIONS,
    bgDataUrl: null,
  });

  function resetOptions() {
    opts = { ...DEFAULT_EXPORT_OPTIONS, bgDataUrl: null };
  }

  async function handleBgChange(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0] ?? null;
    if (!file) return;
    opts.bgDataUrl = await fileToDataUrl(file);
  }

  function clearBg() {
    opts.bgDataUrl = null;
  }

  // ── Live preview ─────────────────────────────────────────────────
  // Rendered in-document (not an iframe) so it uses the app's real fonts and matches the export.
  let previewHtml = $derived(buildPreviewInnerHtml(events, year, month, opts));
  let previewContainerWidth = $state(0);
  let previewScale = $derived(
    previewContainerWidth > 0 ? previewContainerWidth / CALENDAR_CONTAINER_WIDTH : 0
  );

  // ── PDF export ───────────────────────────────────────────────────
  let exporting = $state(false);

  async function handleExport() {
    if (exporting) return;
    exporting = true;
    try {
      await exportCalendarMonth(events, focusDate, opts);
    } finally {
      exporting = false;
    }
  }

  // ── Init ─────────────────────────────────────────────────────────
  onMount(() => {
    filterAssociationId = page.url.searchParams.get('association')?.trim() ?? '';
    const monthParam = page.url.searchParams.get('month');
    if (monthParam) {
      const d = new Date(`${monthParam}-01`);
      if (!isNaN(d.getTime())) focusDate = d;
    }
    void loadMonth();
  });

  const backHref = $derived(
    filterAssociationId ? `/calendar?association=${encodeURIComponent(filterAssociationId)}` : '/calendar'
  );
</script>

<div class="px-4 py-6 sm:px-6 max-w-7xl mx-auto space-y-6">
  <a href={backHref} class="text-sm text-text-muted hover:text-text-main transition-colors">
    ← {m.calendar_export_back()}
  </a>

  <h1 class="text-2xl font-extrabold text-text-main tracking-tight">{m.calendar_export_title()}</h1>

  <div class="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-6 items-start">
    <!-- ── Settings panel ── -->
    <div class="space-y-5 rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 p-5 shadow-sm lg:sticky lg:top-4">

      <!-- Month navigation -->
      <div>
        <p class="text-xs font-bold uppercase tracking-wider text-text-muted mb-2">{m.calendar_export_month_label()}</p>
        <div class="flex items-center gap-2">
          <button
            type="button"
            onclick={prevMonth}
            class="rounded-xl border border-cn-border p-2 text-text-main hover:bg-cn-bg transition-colors"
            aria-label={m.calendar_prev_month()}
          >
            <ChevronLeft size={18} />
          </button>
          <span class="flex-1 text-center text-sm font-bold text-text-main capitalize">{titleMonth}</span>
          <button
            type="button"
            onclick={nextMonth}
            class="rounded-xl border border-cn-border p-2 text-text-main hover:bg-cn-bg transition-colors"
            aria-label={m.calendar_next_month()}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      <hr class="border-cn-border/60" />

      <!-- Background image -->
      <div class="space-y-3">
        <p class="text-xs font-bold uppercase tracking-wider text-text-muted">{m.calendar_export_bg_label()}</p>
        {#if opts.bgDataUrl}
          <div class="flex items-center gap-2">
            <span class="flex-1 text-xs text-text-muted">{m.calendar_export_bg_loaded()}</span>
            <button
              type="button"
              onclick={clearBg}
              class="rounded-lg border border-cn-border p-1.5 text-text-muted hover:bg-cn-bg"
              title={m.calendar_export_bg_remove()}
            >
              <X size={14} />
            </button>
          </div>
        {:else}
          <label class="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-cn-border bg-cn-bg px-3 py-2 text-xs font-semibold text-text-muted hover:bg-[var(--cn-surface)] transition-colors">
            <ImagePlus size={14} />
            {m.calendar_export_bg_choose()}
            <input type="file" accept="image/*" class="sr-only" onchange={handleBgChange} />
          </label>
        {/if}
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">{m.calendar_export_opacity({ value: opts.bgOpacity })}</span>
          <input type="range" min="0" max="100" bind:value={opts.bgOpacity} class="w-28 accent-cn-dark" />
        </div>
      </div>

      <hr class="border-cn-border/60" />

      <!-- Header -->
      <div class="space-y-2">
        <p class="text-xs font-bold uppercase tracking-wider text-text-muted">{m.calendar_export_header_label()}</p>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">{m.calendar_export_bg_field()}</span>
          <ColorPicker bind:value={opts.headerBg} label={m.calendar_export_bg_field()} />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">{m.calendar_export_month_title_color()}</span>
          <ColorPicker bind:value={opts.monthTitleColor} label={m.calendar_export_month_title_color()} />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">{m.calendar_export_text_shadow()}</span>
          <button
            type="button"
            role="switch"
            aria-checked={opts.enableTextShadow}
            onclick={() => (opts.enableTextShadow = !opts.enableTextShadow)}
            aria-label={m.calendar_export_enable_shadows_label()}
            class="relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors {opts.enableTextShadow ? 'bg-cn-yellow' : 'bg-cn-border'}"
          >
            <span class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform {opts.enableTextShadow ? 'translate-x-4' : 'translate-x-0'}"></span>
          </button>
        </div>
        {#if opts.enableTextShadow}
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-text-muted">{m.calendar_export_shadow_color()}</span>
            <ColorPicker bind:value={opts.textShadowColor} label={m.calendar_export_shadow_color()} />
          </div>
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-text-muted">{m.calendar_export_shadow_offset({ value: opts.textShadowOffset })}</span>
            <input type="range" min="1" max="8" bind:value={opts.textShadowOffset} class="w-28 accent-cn-dark" />
          </div>
        {/if}
      </div>

      <hr class="border-cn-border/60" />

      <!-- Weekday row -->
      <div class="space-y-2">
        <p class="text-xs font-bold uppercase tracking-wider text-text-muted">{m.calendar_export_weekday_row_label()}</p>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">{m.calendar_export_bg_field()}</span>
          <ColorPicker bind:value={opts.weekdayRowBg} label={m.calendar_export_weekday_row_label()} />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">{m.calendar_export_weekday_labels()}</span>
          <ColorPicker bind:value={opts.weekdayLabelColor} label={m.calendar_export_weekday_labels()} />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">{m.calendar_export_weekend_labels()}</span>
          <ColorPicker bind:value={opts.weekendLabelColor} label={m.calendar_export_weekend_labels()} />
        </div>
      </div>

      <hr class="border-cn-border/60" />

      <!-- Cells -->
      <div class="space-y-2">
        <p class="text-xs font-bold uppercase tracking-wider text-text-muted">{m.calendar_export_cells_label()}</p>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">{m.calendar_export_cell_bg_normal()}</span>
          <ColorPicker bind:value={opts.cellBg} label={m.calendar_export_cell_bg_normal()} />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">{m.calendar_export_cell_opacity_normal({ value: opts.cellBgOpacity })}</span>
          <input type="range" min="0" max="100" bind:value={opts.cellBgOpacity} class="w-28 accent-cn-dark" />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">{m.calendar_export_cell_bg_weekend()}</span>
          <ColorPicker bind:value={opts.weekendCellBg} label={m.calendar_export_cell_bg_weekend()} />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">{m.calendar_export_cell_opacity_weekend({ value: opts.weekendCellBgOpacity })}</span>
          <input type="range" min="0" max="100" bind:value={opts.weekendCellBgOpacity} class="w-28 accent-cn-dark" />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">{m.calendar_export_empty_day_color()}</span>
          <ColorPicker bind:value={opts.emptyDayColor} label={m.calendar_export_empty_day_color()} />
        </div>
      </div>

      <hr class="border-cn-border/60" />

      <!-- Grid borders -->
      <div class="space-y-2">
        <p class="text-xs font-bold uppercase tracking-wider text-text-muted">{m.calendar_export_grid_label()}</p>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">{m.calendar_export_inner_borders()}</span>
          <ColorPicker bind:value={opts.borderColor} label={m.calendar_export_inner_borders()} />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">{m.calendar_export_outer_border()}</span>
          <ColorPicker bind:value={opts.gridOuterBorder} label={m.calendar_export_outer_border()} />
        </div>
      </div>

      <hr class="border-cn-border/60" />

      <!-- Actions -->
      <div class="flex flex-col gap-2">
        <button
          type="button"
          onclick={handleExport}
          disabled={loading || exporting}
          class="inline-flex items-center justify-center gap-2 rounded-xl bg-cn-yellow px-4 py-3 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover transition-colors disabled:opacity-40 disabled:pointer-events-none"
        >
          <FileDown size={18} />
          {exporting ? m.common_generating_label() : m.calendar_export_download_btn()}
        </button>
        <button
          type="button"
          onclick={resetOptions}
          class="inline-flex items-center justify-center gap-2 rounded-xl border border-cn-border px-4 py-2 text-xs font-semibold text-text-muted hover:bg-cn-bg transition-colors"
        >
          <RotateCcw size={14} />
          {m.calendar_export_reset_colors()}
        </button>
      </div>
    </div>

    <!-- ── Preview panel ── -->
    <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 p-4 shadow-sm">
      <p class="text-xs font-bold uppercase tracking-wider text-text-muted mb-3">{m.calendar_export_preview_label()}</p>
      <div bind:clientWidth={previewContainerWidth}>
        {#if loading}
          <div class="flex items-center justify-center py-16">
            <div class="h-6 w-6 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"></div>
          </div>
        {:else if previewScale > 0}
          <div style="height: {CALENDAR_CONTAINER_HEIGHT * previewScale}px; overflow: hidden;">
            <div
              style="width: {CALENDAR_CONTAINER_WIDTH}px; transform: scale({previewScale}); transform-origin: top left;"
              aria-label={m.calendar_export_preview_title()}
            >
              <!-- eslint-disable-next-line svelte/no-at-html-tags -- titles are HTML-escaped in buildCalendarHtml -->
              {@html previewHtml}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>
