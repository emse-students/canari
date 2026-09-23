<script lang="ts">
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { isGlobalAdmin, isAssociationSuperAdmin } from '$lib/stores/user';
  import {
    listAggregatedCalendarFeed,
    ensureAssociationSuperAdmin,
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
  import { paletteFromImage } from '$lib/calendar/sheetPalette';
  // The sheet's two display faces, loaded by the ONE page that renders it. `calendarExport` is also
  // imported by the on-screen month grid, which draws neither of them and must not fetch them.
  import '@fontsource/leckerli-one/400.css';
  import '@fontsource/chewy/400.css';
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

  /**
   * Back to the one starting point there is, keeping the uploaded background.
   *
   * THERE WERE THREE CURATED PRESETS HERE AND THEY ARE GONE (user, 2026-09-14: *"supprime tes
   * themes 'Rentree, Canari sombre, Minimal' par defaut, c'est juste moche et inutile"*), and the
   * twenty fine-grained pickers that replaced them went the same way on 2026-09-23 (*"ce truc la
   * est quand meme une vraie usine a gaz"*) - along with the header bar, the weekday bar and the
   * grid rules they were colouring. What composes a look now is the image, and the palette follows
   * it.
   */
  function resetOptions() {
    opts = { ...DEFAULT_EXPORT_OPTIONS, bgDataUrl: opts.bgDataUrl };
  }

  /**
   * A new background re-derives the three colours, because a palette that outlived its image is the
   * thing this page existed to make somebody fix by hand.
   *
   * It does NOT re-derive on a reset: a reset is a request for the defaults, and silently putting
   * the picture's colours back would make the button do nothing visible.
   */
  async function handleBgChange(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0] ?? null;
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    opts.bgDataUrl = dataUrl;
    const palette = await paletteFromImage(dataUrl);
    if (palette) opts = { ...opts, ...palette };
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

  /**
   * WHO MAY BUILD AN AGENDA PDF (user, 2026-09-14: *"Exporter le calendrier en pdf ne doit etre
   * possible que pour les admins (systeme ou BDE)"*).
   *
   * `null` until the answer is known, which is NOT the same as `false`: drawing the tool and then
   * yanking it, or flashing a refusal at an admin whose membership request has not landed yet, are
   * both the page answering a question it cannot answer. The two tiers resolve exactly as `/admin`
   * resolves them - the synchronous flag first, then ONE membership request for the BDE half, warm
   * already if the layout asked before us.
   *
   * THIS IS A UI GATE AND IT IS NOT THE ONLY THING THAT MATTERS. The month itself comes from
   * `listAggregatedCalendarFeed`, the same public feed `/calendar` draws, so this takes a TOOL out
   * of a non-admin's reach rather than data they could not already read.
   */
  let mayExport = $state<boolean | null>(null);

  // ── Init ─────────────────────────────────────────────────────────
  onMount(async () => {
    if (isGlobalAdmin() || isAssociationSuperAdmin()) {
      mayExport = true;
    } else {
      mayExport = await ensureAssociationSuperAdmin().catch(() => false);
      if (!mayExport) {
        await goto('/calendar');
        return;
      }
    }
    filterAssociationId = page.url.searchParams.get('association')?.trim() ?? '';
    const monthParam = page.url.searchParams.get('month');
    if (monthParam) {
      const d = new Date(`${monthParam}-01`);
      if (!isNaN(d.getTime())) focusDate = d;
    }
    void loadMonth();
  });

  const backHref = $derived(
    filterAssociationId
      ? `/calendar?association=${encodeURIComponent(filterAssociationId)}`
      : '/calendar'
  );
</script>

<!-- `grid` AND NOT `tool`, because what this page is mostly showing is A MONTH - the case
     `pageWidth.ts` names for that value, and the width `/calendar` itself already takes. The
     preview is a 1080px PDF page: at the 1024px tool measure its column was 616px and the month
     was rendered at 57%, which is a thumbnail of the thing the page exists to let you check. -->
<PageContainer width="grid">
  <PageHeader title={m.calendar_export_title()} {backHref} backLabel={m.calendar_export_back()} />

  <!--
    NOTHING IS DRAWN UNTIL THE ANSWER IS KNOWN. `mayExport` is `null` while the BDE half is in
    flight, and a non-admin is sent to `/calendar` instead - so this branch is the one that keeps
    the tool from existing for the fraction of a second before the redirect lands.
  -->
  {#if mayExport}
    <div class="space-y-6">
      <!-- `minmax(0,1fr)` AND NOT `1fr`, WHICH IS THE WHOLE OF THE OVERFLOW BUG (user, 2026-09-10:
         *"je suis trop large (et en plus il y a une marge inutile a gauche)"*).
         A grid track written `1fr` is `minmax(auto,1fr)`, and `auto` as a MINIMUM means the track
         may not shrink below its content's min-content width. The preview's inner element is a
         hard `width: 1080px` (`CALENDAR_CONTAINER_WIDTH`) - a PDF page is a fixed size - and the
         `transform: scale()` that shrinks it on screen does not change its LAYOUT size, so the
         track's floor was 1080 + the card's padding = 1114px, measured. The row therefore
         demanded 360 + 24 + 1114 = 1498px inside a 1024px column and simply stuck out of it,
         which is BOTH halves of the report at once: the page column is centred, so the part that
         fits looks pushed right and leaves a margin on the left while the rest runs off the
         right. `minmax(0,...)` says the track may be as narrow as the layout needs; the wrapper's
         `overflow: hidden` was already there to clip what the scale leaves over, and
         `previewScale` recomputes off `bind:clientWidth`, so the preview simply resizes. -->
      <div class="grid grid-cols-1 items-start gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        <!-- ── Settings panel ── -->
        <div
          class="border-cn-border bg-cn-surface space-y-5 rounded-2xl border p-5 shadow-sm lg:sticky lg:top-4"
        >
          <!-- Month navigation -->
          <div>
            <p class="text-text-muted mb-2 text-xs font-bold tracking-wider uppercase">
              {m.calendar_export_month_label()}
            </p>
            <div class="flex items-center gap-2">
              <button
                type="button"
                onclick={prevMonth}
                class="ui-icon-button border-cn-border text-text-main hover:bg-cn-bg rounded-xl border transition-colors"
                aria-label={m.calendar_prev_month()}
              >
                <ChevronLeft size={18} />
              </button>
              <span class="text-text-main flex-1 text-center text-sm font-bold capitalize"
                >{titleMonth}</span
              >
              <button
                type="button"
                onclick={nextMonth}
                class="ui-icon-button border-cn-border text-text-main hover:bg-cn-bg rounded-xl border transition-colors"
                aria-label={m.calendar_next_month()}
              >
                <ChevronRight size={18} />
              </button>
            </div>
          </div>

          <hr class="border-cn-border/60" />

          <!-- Background image: the one thing that really changes from month to month. -->
          <div class="space-y-3">
            <p class="text-text-muted text-xs font-bold tracking-wider uppercase">
              {m.calendar_export_bg_label()}
            </p>
            {#if opts.bgDataUrl}
              <div class="flex items-center gap-2">
                <span class="text-text-muted flex-1 text-xs">{m.calendar_export_bg_loaded()}</span>
                <button
                  type="button"
                  onclick={clearBg}
                  class="ui-icon-button border-cn-border text-text-muted hover:bg-cn-bg rounded-lg border"
                  title={m.calendar_export_bg_remove()}
                >
                  <X size={14} />
                </button>
              </div>
            {:else}
              <label
                class="border-cn-border bg-cn-bg text-text-muted inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors hover:bg-(--cn-surface)"
              >
                <ImagePlus size={14} />
                {m.calendar_export_bg_choose()}
                <input type="file" accept="image/*" class="sr-only" onchange={handleBgChange} />
              </label>
            {/if}
            <div class="flex items-center justify-between gap-2">
              <span class="text-text-muted text-xs"
                >{m.calendar_export_image_intensity({ value: opts.bgOpacity })}</span
              >
              <input
                type="range"
                min="0"
                max="100"
                bind:value={opts.bgOpacity}
                class="accent-cn-dark w-28"
              />
            </div>
            <!-- A scrim only darkens the photograph, so it has nothing to do without one. -->
            {#if opts.bgDataUrl}
              <div class="flex items-center justify-between gap-2">
                <span class="text-text-muted text-xs"
                  >{m.calendar_export_scrim({ value: opts.scrimOpacity })}</span
                >
                <input
                  type="range"
                  min="0"
                  max="80"
                  bind:value={opts.scrimOpacity}
                  class="accent-cn-dark w-28"
                />
              </div>
            {/if}
          </div>

          <hr class="border-cn-border/60" />

          <!-- The two dosages that decide how much of the photograph survives the grid over it. -->
          <div class="space-y-2">
            <div class="flex items-center justify-between gap-2">
              <span class="text-text-muted text-xs"
                >{m.calendar_export_cell_opacity({ value: opts.cellBgOpacity })}</span
              >
              <input
                type="range"
                min="0"
                max="100"
                bind:value={opts.cellBgOpacity}
                class="accent-cn-dark w-28"
              />
            </div>
            <div class="flex items-center justify-between gap-2">
              <span class="text-text-muted text-xs"
                >{m.calendar_export_logo_strength({ value: opts.logoOpacity })}</span
              >
              <input
                type="range"
                min="0"
                max="100"
                bind:value={opts.logoOpacity}
                class="accent-cn-dark w-28"
              />
            </div>
          </div>

          <hr class="border-cn-border/60" />

          <!-- Three colours, pre-filled from the image by `paletteFromImage` and overridable. -->
          <div class="space-y-2">
            <p class="text-text-muted text-xs font-bold tracking-wider uppercase">
              {m.calendar_export_colors_label()}
            </p>
            {#if opts.bgDataUrl}
              <p class="text-text-muted text-2xs">{m.calendar_export_palette_hint()}</p>
            {/if}
            <div class="flex items-center justify-between gap-2">
              <span class="text-text-muted text-xs">{m.calendar_export_color_text()}</span>
              <ColorPicker bind:value={opts.textColor} label={m.calendar_export_color_text()} />
            </div>
            <div class="flex items-center justify-between gap-2">
              <span class="text-text-muted text-xs">{m.calendar_export_color_accent()}</span>
              <ColorPicker bind:value={opts.accentColor} label={m.calendar_export_color_accent()} />
            </div>
            <div class="flex items-center justify-between gap-2">
              <span class="text-text-muted text-xs">{m.calendar_export_color_cells()}</span>
              <ColorPicker bind:value={opts.cellBg} label={m.calendar_export_color_cells()} />
            </div>
          </div>

          <hr class="border-cn-border/60" />

          <!-- Actions -->
          <div class="flex flex-col gap-2">
            <button
              type="button"
              onclick={handleExport}
              disabled={loading || exporting}
              class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold transition-colors disabled:pointer-events-none disabled:opacity-40"
            >
              <FileDown size={18} />
              {exporting ? m.common_generating_label() : m.calendar_export_download_btn()}
            </button>
            <button
              type="button"
              onclick={resetOptions}
              class="border-cn-border text-text-muted hover:bg-cn-bg inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-2 text-xs font-semibold transition-colors"
            >
              <RotateCcw size={14} />
              {m.calendar_export_reset()}
            </button>
          </div>
        </div>

        <!-- ── Preview panel ── -->
        <div class="border-cn-border bg-cn-surface rounded-2xl border p-4 shadow-sm">
          <p class="text-text-muted mb-3 text-xs font-bold tracking-wider uppercase">
            {m.calendar_export_preview_label()}
          </p>
          <div bind:clientWidth={previewContainerWidth}>
            {#if loading}
              <div class="flex items-center justify-center py-16">
                <div
                  class="border-cn-yellow h-6 w-6 animate-spin rounded-full border-4 border-t-transparent"
                ></div>
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
  {/if}
</PageContainer>
