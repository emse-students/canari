<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import {
    listAggregatedCalendarFeed,
    type AssociationCalendarFeedEvent,
  } from '$lib/associations/api';
  import {
    buildPreviewDocument,
    exportCalendarMonth,
    DEFAULT_EXPORT_OPTIONS,
    CALENDAR_CONTAINER_HEIGHT,
    fileToDataUrl,
    type CalendarExportOptions,
  } from '$lib/utils/calendarExport';
  import { ChevronLeft, ChevronRight, FileDown, ImagePlus, X, RotateCcw } from '@lucide/svelte';

  // ── Month navigation ─────────────────────────────────────────────
  let focusDate = $state(new Date());
  let year = $derived(focusDate.getFullYear());
  let month = $derived(focusDate.getMonth());
  let filterAssociationId = $state('');

  const titleMonth = $derived(
    new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(focusDate)
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
  let previewHtml = $derived(buildPreviewDocument(events, year, month, opts));
  let previewContainerWidth = $state(0);
  let previewScale = $derived(previewContainerWidth > 0 ? previewContainerWidth / 1080 : 0);

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
    ← Retour à l'agenda
  </a>

  <h1 class="text-2xl font-extrabold text-text-main tracking-tight">Export PDF</h1>

  <div class="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-6 items-start">
    <!-- ── Settings panel ── -->
    <div class="space-y-5 rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 p-5 shadow-sm lg:sticky lg:top-4">

      <!-- Month navigation -->
      <div>
        <p class="text-xs font-bold uppercase tracking-wider text-text-muted mb-2">Mois</p>
        <div class="flex items-center gap-2">
          <button
            type="button"
            onclick={prevMonth}
            class="rounded-xl border border-cn-border p-2 text-text-main hover:bg-cn-bg transition-colors"
            aria-label="Mois précédent"
          >
            <ChevronLeft size={18} />
          </button>
          <span class="flex-1 text-center text-sm font-bold text-text-main capitalize">{titleMonth}</span>
          <button
            type="button"
            onclick={nextMonth}
            class="rounded-xl border border-cn-border p-2 text-text-main hover:bg-cn-bg transition-colors"
            aria-label="Mois suivant"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      <hr class="border-cn-border/60" />

      <!-- Background image -->
      <div class="space-y-3">
        <p class="text-xs font-bold uppercase tracking-wider text-text-muted">Image de fond</p>
        {#if opts.bgDataUrl}
          <div class="flex items-center gap-2">
            <span class="flex-1 text-xs text-text-muted">Image chargée</span>
            <button
              type="button"
              onclick={clearBg}
              class="rounded-lg border border-cn-border p-1.5 text-text-muted hover:bg-cn-bg"
              title="Supprimer l'image de fond"
            >
              <X size={14} />
            </button>
          </div>
        {:else}
          <label class="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-cn-border bg-cn-bg px-3 py-2 text-xs font-semibold text-text-muted hover:bg-[var(--cn-surface)] transition-colors">
            <ImagePlus size={14} />
            Choisir une image
            <input type="file" accept="image/*" class="sr-only" onchange={handleBgChange} />
          </label>
        {/if}
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">Opacité ({opts.bgOpacity}%)</span>
          <input type="range" min="0" max="100" bind:value={opts.bgOpacity} class="w-28 accent-cn-dark" />
        </div>
      </div>

      <hr class="border-cn-border/60" />

      <!-- Header -->
      <div class="space-y-2">
        <p class="text-xs font-bold uppercase tracking-wider text-text-muted">En-tête</p>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">Fond</span>
          <input type="color" bind:value={opts.headerBg} class="h-7 w-14 cursor-pointer rounded border border-cn-border" />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">Titre du mois</span>
          <input type="color" bind:value={opts.monthTitleColor} class="h-7 w-14 cursor-pointer rounded border border-cn-border" />
        </div>
      </div>

      <hr class="border-cn-border/60" />

      <!-- Weekday row -->
      <div class="space-y-2">
        <p class="text-xs font-bold uppercase tracking-wider text-text-muted">Ligne des jours</p>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">Fond</span>
          <input type="color" bind:value={opts.weekdayRowBg} class="h-7 w-14 cursor-pointer rounded border border-cn-border" />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">Étiquettes sem.</span>
          <input type="color" bind:value={opts.weekdayLabelColor} class="h-7 w-14 cursor-pointer rounded border border-cn-border" />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">Étiquettes w-e</span>
          <input type="color" bind:value={opts.weekendLabelColor} class="h-7 w-14 cursor-pointer rounded border border-cn-border" />
        </div>
      </div>

      <hr class="border-cn-border/60" />

      <!-- Cells -->
      <div class="space-y-2">
        <p class="text-xs font-bold uppercase tracking-wider text-text-muted">Cases</p>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">Fond normal</span>
          <input type="color" bind:value={opts.cellBg} class="h-7 w-14 cursor-pointer rounded border border-cn-border" />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">Opacité normal ({opts.cellBgOpacity}%)</span>
          <input type="range" min="0" max="100" bind:value={opts.cellBgOpacity} class="w-28 accent-cn-dark" />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">Fond week-end</span>
          <input type="color" bind:value={opts.weekendCellBg} class="h-7 w-14 cursor-pointer rounded border border-cn-border" />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">Opacité w-e ({opts.weekendCellBgOpacity}%)</span>
          <input type="range" min="0" max="100" bind:value={opts.weekendCellBgOpacity} class="w-28 accent-cn-dark" />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">Numéros vides</span>
          <input type="color" bind:value={opts.emptyDayColor} class="h-7 w-14 cursor-pointer rounded border border-cn-border" />
        </div>
      </div>

      <hr class="border-cn-border/60" />

      <!-- Grid borders -->
      <div class="space-y-2">
        <p class="text-xs font-bold uppercase tracking-wider text-text-muted">Grille</p>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">Bordures internes</span>
          <input type="color" bind:value={opts.borderColor} class="h-7 w-14 cursor-pointer rounded border border-cn-border" />
        </div>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-text-muted">Contour extérieur</span>
          <input type="color" bind:value={opts.gridOuterBorder} class="h-7 w-14 cursor-pointer rounded border border-cn-border" />
        </div>
      </div>

      <hr class="border-cn-border/60" />

      <!-- Actions -->
      <div class="flex flex-col gap-2">
        <button
          type="button"
          onclick={handleExport}
          disabled={loading || exporting}
          class="inline-flex items-center justify-center gap-2 rounded-xl bg-cn-yellow px-4 py-3 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover transition-colors disabled:opacity-40 disabled:pointer-events-none"
        >
          <FileDown size={18} />
          {exporting ? 'Génération…' : 'Télécharger le PDF'}
        </button>
        <button
          type="button"
          onclick={resetOptions}
          class="inline-flex items-center justify-center gap-2 rounded-xl border border-cn-border px-4 py-2 text-xs font-semibold text-text-muted hover:bg-cn-bg transition-colors"
        >
          <RotateCcw size={14} />
          Réinitialiser les couleurs
        </button>
      </div>
    </div>

    <!-- ── Preview panel ── -->
    <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 p-4 shadow-sm">
      <p class="text-xs font-bold uppercase tracking-wider text-text-muted mb-3">Aperçu</p>
      <div bind:clientWidth={previewContainerWidth}>
        {#if loading}
          <div class="flex items-center justify-center py-16">
            <div class="h-6 w-6 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"></div>
          </div>
        {:else if previewScale > 0}
          <div style="height: {CALENDAR_CONTAINER_HEIGHT * previewScale}px; overflow: hidden;">
            <iframe
              srcdoc={previewHtml}
              width="1080"
              height={CALENDAR_CONTAINER_HEIGHT}
              style="transform: scale({previewScale}); transform-origin: top left; border: none; display: block;"
              title="Aperçu du calendrier"
            ></iframe>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>
