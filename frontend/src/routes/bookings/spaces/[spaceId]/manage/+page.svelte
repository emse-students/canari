<script lang="ts">
  import { internalPath } from '$lib/utils/internalPath';
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import { CalendarDays, Download, ListChecks, Settings } from '@lucide/svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import EmptyState from '$lib/components/shared/EmptyState.svelte';
  import SpaceWeek from '$lib/components/bookings/booker/SpaceWeek.svelte';
  import UpcomingBookings from '$lib/components/bookings/organiser/UpcomingBookings.svelte';
  import { getSpace, type BookerSpace, type ResourceSlots } from '$lib/bookings/api';
  import { downloadSpaceExport } from '$lib/bookings/bookingActions';
  import { columnsHidden } from '$lib/bookings/columns';
  import { hoursOf, weekCounters, type WeekCounters } from '$lib/bookings/dashboard';
  import { redrawEveryMinuteAndAt } from '$lib/bookings/redrawClock';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import {
    BOOKINGS_HREF,
    spaceDashboardHref,
    spaceEditorHref,
    spaceHref,
  } from '$lib/bookings/routes';
  import { setPageTitle } from '$lib/seo/pageTitle.svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * THE ORGANISER'S DASHBOARD OF ONE SPACE (WP-R5, D50): the week's counters (Q-R16), what is coming
   * and who booked it with its cancel in place (`UpcomingBookings`), and the week in BLOCK mode
   * (`SpaceWeek`), where a drag over free units opens "Indisponible" and a taken unit opens who
   * booked, their answers and the cancel. While the space has its one hidden column (D44) the
   * "Ajouter une colonne" card leads to the editor, where a column is named. The server holds every
   * right: a reader who does not manage the space is told so, and reads nothing else.
   */

  type Tab = 'upcoming' | 'planning';

  const spaceId = $derived(page.params.spaceId ?? '');

  let space = $state<BookerSpace | null>(null);
  let loading = $state(true);
  let loadError = $state('');
  let nowMs = $state(Date.now());
  let tab = $state<Tab>('upcoming');
  let counters = $state<WeekCounters | null>(null);
  let exporting = $state(false);
  let exportError = $state('');
  let upcoming = $state<{ reload: () => Promise<boolean> } | null>(null);
  let week = $state<{ reread: () => Promise<void> } | null>(null);

  const oneColumn = $derived(space ? columnsHidden(space.name, space.resources) : false);

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
    counters = null;
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
    if (space) counters = weekCounters(slots, days, space.timeZone);
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

  const actionClass =
    'ui-icon-button text-text-muted hover:text-text-main hover:bg-cn-border/30 rounded-lg';
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
        <div class="flex items-center gap-1">
          <a
            href={resolve(internalPath(spaceHref(space.id)))}
            class={actionClass}
            aria-label={m.bookings_dashboard_view_page()}
            title={m.bookings_dashboard_view_page()}
          >
            <CalendarDays size={18} />
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
          </button>
          <a
            href={resolve(internalPath(spaceEditorHref(space.id)))}
            class={actionClass}
            aria-label={m.bookings_dashboard_settings()}
            title={m.bookings_dashboard_settings()}
          >
            <Settings size={18} />
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

      {#if counters}
        <!-- The mockup's pills: one line of the week's numbers above everything else. -->
        <dl class="flex flex-wrap gap-2" aria-label={m.bookings_dashboard_counters_label()}>
          {#each [{ label: m.bookings_dashboard_count_bookings(), value: String(counters.bookings) }, { label: m.bookings_dashboard_count_hours(), value: m.bookings_dashboard_hours_of( { booked: hoursOf(counters.bookedMinutes), offered: hoursOf(counters.offeredMinutes) } ) }, { label: m.bookings_dashboard_count_blocks(), value: String(counters.blocks) }] as pill (pill.label)}
            <div
              class="border-cn-border bg-cn-surface inline-flex items-baseline gap-1.5 rounded-full border px-3 py-1"
            >
              <dt class="text-text-muted text-xs">{pill.label}</dt>
              <dd class="text-text-main text-sm font-bold tabular-nums">{pill.value}</dd>
            </div>
          {/each}
        </dl>
      {/if}

      {#if oneColumn}
        <div
          class="border-cn-border bg-cn-bg flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3"
        >
          <div class="min-w-0 flex-[1_1_16rem]">
            <p class="text-text-main text-sm font-semibold">{m.bookings_columns_hidden_title()}</p>
            <p class="text-text-muted text-xs">{m.bookings_columns_hidden_hint()}</p>
          </div>
          <a
            href={resolve(internalPath(spaceEditorHref(space.id)))}
            class="border-cn-border text-text-main hover:border-cn-yellow/40 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors"
          >
            {m.bookings_resource_add_button()}
          </a>
        </div>
      {/if}

      <!-- Two columns side by side from lg (the mockup's desktop); below it, one at a time. -->
      <div class="lg:hidden">
        <SegmentedControl
          items={[
            { key: 'upcoming', label: m.bookings_dashboard_tab_upcoming(), icon: ListChecks },
            { key: 'planning', label: m.bookings_dashboard_tab_planning(), icon: CalendarDays },
          ]}
          value={tab}
          onSelect={(key: Tab) => (tab = key)}
          label={m.bookings_dashboard_title()}
        />
      </div>

      <!-- Both stay mounted: the counters come from the week's read, the list from its own. -->
      {#key space.id}
        <div class="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6">
          <div class={tab !== 'planning' ? 'max-lg:hidden' : ''}>
            <SpaceWeek
              bind:this={week}
              {space}
              bind:nowMs
              mode="block"
              onWeekRead={weekRead}
              onChanged={() => void upcoming?.reload()}
            />
          </div>
          <aside class={tab !== 'upcoming' ? 'max-lg:hidden' : ''}>
            <h2 class="text-text-main mb-3 hidden text-sm font-bold lg:block">
              {m.bookings_dashboard_tab_upcoming()}
            </h2>
            <UpcomingBookings
              bind:this={upcoming}
              {space}
              {nowMs}
              onChanged={() => void week?.reread()}
            />
          </aside>
        </div>
      {/key}
    </div>
  {/if}
</PageContainer>
