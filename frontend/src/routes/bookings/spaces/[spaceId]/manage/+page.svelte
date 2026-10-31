<script lang="ts">
  import { internalPath } from '$lib/utils/internalPath';
  import { onMount, untrack } from 'svelte';
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import { CalendarDays, Download, Eye, MousePointerClick, Settings } from '@lucide/svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import EmptyState from '$lib/components/shared/EmptyState.svelte';
  import SpaceWeek from '$lib/components/bookings/booker/SpaceWeek.svelte';
  import UpcomingBookings from '$lib/components/bookings/organiser/UpcomingBookings.svelte';
  import { getSpace, type BookerSpace, type ResourceSlots } from '$lib/bookings/api';
  import { downloadSpaceExport } from '$lib/bookings/bookingActions';
  import { weekBookingCount } from '$lib/bookings/dashboard';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import { gridDragHint } from '$lib/bookings/gridHint';
  import { gridUnitLimit } from '$lib/bookings/grid';
  import { redrawEveryMinuteAndAt } from '$lib/bookings/redrawClock';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import {
    BOOKINGS_HREF,
    spaceDashboardHref,
    spaceEditorHref,
    spaceHref,
  } from '$lib/bookings/routes';
  import { setPageTitle } from '$lib/seo/pageTitle.svelte';
  import { isCoarsePointerDevice, onCoarsePointerChange } from '$lib/utils/pointerDevice';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * THE ORGANISER'S DASHBOARD OF ONE SPACE (WP-R5, D50): the week's counters (Q-R16), what is coming
   * and who booked it with its cancel in place (`UpcomingBookings`), and the week in BLOCK mode
   * (`SpaceWeek`), where a drag over free units opens "Indisponible" and a taken unit opens who
   * booked, their answers and the cancel. A column is added in the editor ("Réglages"), never from
   * here. The server holds every right: a reader who does not manage the space is told so, and reads nothing else.
   */

  type Tab = 'upcoming' | 'planning';

  const spaceId = $derived(page.params.spaceId ?? '');

  let space = $state<BookerSpace | null>(null);
  let loading = $state(true);
  let loadError = $state('');
  let nowMs = $state(Date.now());
  let tab = $state<Tab>('upcoming');
  /** The week's distinct bookings, from the grid's own read; null until it lands. */
  let weekBookings = $state<number | null>(null);
  let exporting = $state(false);
  let exportError = $state('');
  let upcoming = $state<{ reload: () => Promise<boolean> } | null>(null);
  let week = $state<{ reread: () => Promise<void> } | null>(null);

  /** Whether the reader's primary pointer is a finger: the hint names only the gesture that applies. */
  let coarse = $state(isCoarsePointerDevice());
  onMount(() => {
    coarse = isCoarsePointerDevice();
    return onCoarsePointerChange((value) => (coarse = value));
  });

  $effect(() => {
    if (!space) return;
    setPageTitle(space.name);
    return () => setPageTitle(null);
  });

  // The route parameter, not the mount: SvelteKit keeps this page from one space to another.
  $effect(() => {
    const id = spaceId;
    untrack(() => void load(id));
  });

  // The device's clock only redraws ("under way", a unit's reading); the server decides.
  $effect(() => redrawEveryMinuteAndAt(null, (now) => (nowMs = now)));

  async function load(id: string) {
    Log.d('BOOKINGS', `dashboard load space=${id}`);
    loading = true;
    loadError = '';
    space = null;
    weekBookings = null;
    try {
      const loaded = await getSpace(id);
      if (id !== spaceId) return;
      nowMs = Date.now();
      space = loaded;
      if (!loaded.canManage) Log.i('BOOKINGS', `dashboard refused: not an organiser of ${id}`);
    } catch (e) {
      if (id !== spaceId) return;
      Log.i('BOOKINGS', `dashboard read failed space=${id}: ${String(e)}`);
      loadError = describeBookingRefusal(e, m.common_load_error());
    } finally {
      if (id === spaceId) loading = false;
    }
  }

  function weekRead(slots: ResourceSlots[], days: string[]) {
    if (space) weekBookings = weekBookingCount(slots, days, space.timeZone);
  }

  async function exportXlsx() {
    if (!space || exporting) return;
    exporting = true;
    exportError = '';
    try {
      await downloadSpaceExport(space);
    } catch (e) {
      Log.i('BOOKINGS', `dashboard export refused: ${String(e)}`);
      exportError = describeBookingRefusal(e, m.bookings_export_button());
    } finally {
      exporting = false;
    }
  }

  /** The mockup's header buttons: filled, the icon always and the word from `sm` up. */
  const actionClass =
    'bg-control-fill text-text-main hover:bg-cn-border/60 inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold transition-colors disabled:opacity-40 sm:min-h-10';
</script>

<PageContainer width="tool">
  <PageHeader
    title={space?.name ?? m.bookings_dashboard_title()}
    subtitle={space ? m.bookings_dashboard_title() : undefined}
    crumbs={space
      ? [
          { label: m.bookings_page_title(), href: BOOKINGS_HREF },
          { label: space.name, href: spaceHref(space.id) },
          { label: m.bookings_dashboard_title(), href: spaceDashboardHref(space.id) },
        ]
      : undefined}
  >
    {#snippet actions()}
      {#if space?.canManage}
        <div class="flex flex-wrap items-center gap-2">
          <a
            href={resolve(internalPath(spaceHref(space.id)))}
            class={actionClass}
            aria-label={m.bookings_dashboard_view_page()}
            title={m.bookings_dashboard_view_page()}
          >
            <Eye size={18} />
            <span class="max-sm:sr-only">{m.bookings_dashboard_view_page_short()}</span>
          </a>
          <button
            type="button"
            class={actionClass}
            disabled={exporting}
            aria-label={m.bookings_export_button()}
            title={m.bookings_export_button()}
            onclick={() => void exportXlsx()}
          >
            <Download size={18} />
            <span class="max-sm:sr-only">{m.bookings_dashboard_export_short()}</span>
          </button>
          <a
            href={resolve(internalPath(spaceEditorHref(space.id)))}
            class={actionClass}
            aria-label={m.bookings_dashboard_settings()}
            title={m.bookings_dashboard_settings()}
          >
            <Settings size={18} />
            <span class="max-sm:sr-only">{m.bookings_dashboard_settings_short()}</span>
          </a>
        </div>
      {/if}
    {/snippet}
  </PageHeader>

  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div
        class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else if loadError || !space}
    <p
      class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm"
      role="alert"
    >
      {loadError}
    </p>
  {:else if !space.canManage}
    <p class="border-cn-border bg-cn-bg text-text-main rounded-xl border px-4 py-3 text-sm">
      {m.bookings_dashboard_not_manager()}
    </p>
  {:else if space.resources.length === 0}
    <EmptyState
      icon={CalendarDays}
      title={m.bookings_space_empty_title()}
      description={m.bookings_space_empty_desc()}
    />
  {:else}
    <div class="space-y-4">
      {#if exportError}
        <p
          class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm"
          role="alert"
        >
          {exportError}
        </p>
      {/if}

      {#if weekBookings !== null}
        <!-- The week's one number above everything else (owner, 2026-10-31: the hours and blocks
             chips were removed), then the drag that blocks. -->
        <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <dl class="flex flex-wrap gap-2" aria-label={m.bookings_dashboard_counters_label()}>
            <div
              class="bg-control-fill text-text-main inline-flex items-baseline gap-1.5 rounded-full px-3 py-1"
            >
              <dt class="text-text-muted text-xs">{m.bookings_dashboard_count_bookings()}</dt>
              <dd class="text-sm font-bold tabular-nums">{weekBookings}</dd>
            </div>
          </dl>
          <!-- The drag that blocks, said in the words of the pointer the reader has. -->
          {#if gridUnitLimit(space, true) > 1}
            <p class="text-text-muted flex items-center gap-1.5 text-xs">
              <MousePointerClick size={14} aria-hidden="true" />
              {gridDragHint(true, coarse)}
            </p>
          {/if}
        </div>
      {/if}

      <!-- Two columns side by side from lg (the mockup's desktop); below it, one at a time. -->
      <SegmentedControl
        class="lg:hidden"
        variant="underline"
        idPrefix="dashboard-"
        items={[
          { key: 'upcoming', label: m.bookings_dashboard_tab_upcoming() },
          { key: 'planning', label: m.bookings_dashboard_tab_planning() },
        ]}
        value={tab}
        onSelect={(key: Tab) => (tab = key)}
        label={m.bookings_dashboard_title()}
      />

      <!-- Both stay mounted: the counters come from the week's read, the list from its own. -->
      {#key space.id}
        <div class="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6">
          <div
            id="dashboard-tabpanel-planning"
            role="tabpanel"
            aria-labelledby="dashboard-tab-planning"
            class={tab !== 'planning' ? 'max-lg:hidden' : ''}
          >
            <SpaceWeek
              bind:this={week}
              {space}
              bind:nowMs
              mode="block"
              onWeekRead={weekRead}
              onChanged={() => void upcoming?.reload()}
            />
          </div>
          <div
            id="dashboard-tabpanel-upcoming"
            role="tabpanel"
            aria-labelledby="dashboard-tab-upcoming"
            class={tab !== 'upcoming' ? 'max-lg:hidden' : ''}
          >
            <h2 class="text-text-main mb-3 hidden text-sm font-bold lg:block">
              {m.bookings_dashboard_tab_upcoming()}
            </h2>
            <UpcomingBookings
              bind:this={upcoming}
              {space}
              {nowMs}
              onChanged={() => void week?.reread()}
            />
          </div>
        </div>
      {/key}
    </div>
  {/if}
</PageContainer>
