<script lang="ts">
  import { internalPath } from '$lib/utils/internalPath';
  import { onMount, untrack } from 'svelte';
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import { CalendarDays, Link, Pencil, QrCode } from '@lucide/svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import SpacePoster from '$lib/components/bookings/SpacePoster.svelte';
  import EmptyState from '$lib/components/shared/EmptyState.svelte';
  import QrCodeModal from '$lib/components/shared/QrCodeModal.svelte';
  import SpaceGrid from '$lib/components/bookings/booker/SpaceGrid.svelte';
  import ColumnSelect from '$lib/components/bookings/booker/ColumnSelect.svelte';
  import DayStrip from '$lib/components/bookings/booker/DayStrip.svelte';
  import WeekBar from '$lib/components/bookings/booker/WeekBar.svelte';
  import BookingSheet from '$lib/components/bookings/booker/BookingSheet.svelte';
  import BlockSheet from '$lib/components/bookings/booker/BlockSheet.svelte';
  import UnitDetailSheet from '$lib/components/bookings/booker/UnitDetailSheet.svelte';
  import {
    getSlots,
    getSpace,
    myBookings,
    type BookerResource,
    type BookerSpace,
    type MyBooking,
    type ResourceSlots,
    type SlotUnit,
  } from '$lib/bookings/api';
  import {
    BLOCK_LENGTH_CHOICES,
    bookingUnitLimit,
    formatWeekRange,
    freeCount,
    freeRunFrom,
    unitDay,
    unitsInOrder,
    weekDates,
    weekLayout,
    weekReadRange,
    windowRefusal,
    zoneDiffersFromDevice,
    WEEK_DAYS,
  } from '$lib/bookings/grid';
  import { addDays, localDate } from '$lib/bookings/zonedTime';
  import { redrawEveryMinuteAndAt } from '$lib/bookings/redrawClock';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import { BOOKINGS_HREF, spaceEditorHref, spaceHref } from '$lib/bookings/routes';
  import { setPageTitle } from '$lib/seo/pageTitle.svelte';
  import { copyPublicShareLink } from '$lib/utils/copyShareLink';
  import { publicAppUrl } from '$lib/utils/publicAppUrl';
  import { exactDate } from '$lib/utils/time';
  import {
    SCHEDULE_AGENDA_QUERY,
    isScheduleAgendaViewport,
    onViewportChange,
  } from '$lib/utils/viewport';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * THE BOOKER'S PAGE OF ONE SPACE (WP-B5, WP-R2): the WEEK of one column, days as columns on a
   * desktop and one day under a week strip on a phone (D46, D48; the width decides, as the agenda's
   * does, and there is no other view since D47), the sheets that book, block and read a taken unit,
   * and the space's link and QR code (D16). One read holds the week and the day before it, so the
   * strip's dots, the day and the column selector's counts come from the same answer. The server
   * holds every rule: this page reads what it is sent, draws the booking window on the device's
   * clock - redrawn every minute and at the opening instant - and lets every tap reach the server's
   * answer.
   */

  type Sheet =
    | {
        kind: 'book';
        resource: BookerResource;
        run: SlotUnit[];
        /** The units a drag over the grid already selected (1 for a tap). */
        initialCount: number;
        blockRun: SlotUnit[];
        windowNote: boolean;
      }
    | { kind: 'block'; resource: BookerResource; run: SlotUnit[] }
    | { kind: 'detail'; resource: BookerResource; unit: SlotUnit };

  const spaceId = $derived(page.params.spaceId ?? '');

  let space = $state<BookerSpace | null>(null);
  let slots = $state<ResourceSlots[]>([]);
  let loaded = $state<{ from: string; to: string } | null>(null);
  let mine = $state<Map<string, MyBooking>>(new Map());
  let loading = $state(true);
  let loadError = $state('');
  let slotsError = $state('');
  let nowMs = $state(Date.now());
  /** A phone draws one day under the strip; wider screens draw the week. */
  let narrow = $state(isScheduleAgendaViewport());
  /** The day shown (a phone), and with it the week shown. */
  let date = $state('');
  /** The column one books: a space with several columns shows one at a time (D44, D46). */
  let resourceId = $state('');
  let sheet = $state<Sheet | null>(null);
  let qrOpen = $state(false);

  const today = $derived(space ? localDate(nowMs, space.timeZone) : '');
  const resource = $derived(
    space ? (space.resources.find((r) => r.id === resourceId) ?? space.resources[0]) : null
  );
  const weekAll = $derived(date ? weekDates(date) : []);
  const columnUnits = $derived(resource ? unitsInOrder(slots, resource.id) : []);
  /** The week of the chosen column: the strip's dots, and the desktop grid. */
  const week = $derived(space ? weekLayout(columnUnits, weekAll, space, nowMs) : null);
  /** What the grid draws: the week, or on a phone the chosen day alone on its own axis. */
  const layout = $derived(
    space ? (narrow ? weekLayout(columnUnits, [date], space, nowMs) : week) : null
  );
  const freeCounts = $derived(
    new Map(
      space
        ? space.resources.map((r) => [
            r.id,
            freeCount(
              unitsInOrder(slots, r.id).filter((u) =>
                weekAll.includes(unitDay(u, space!.timeZone))
              ),
              space!,
              nowMs
            ),
          ])
        : []
    )
  );
  const weekLabel = $derived(weekAll.length ? formatWeekRange(weekAll) : '');
  const notOpenYet = $derived(
    space?.opensAt && Date.parse(space.opensAt) > nowMs ? space.opensAt : null
  );

  $effect(() => {
    if (!space) return;
    setPageTitle(space.name);
    return () => setPageTitle(null);
  });

  onMount(() =>
    onViewportChange(SCHEDULE_AGENDA_QUERY, (isNarrow) => {
      narrow = isNarrow;
    })
  );

  // The route parameter, not the mount: SvelteKit keeps this page from one space to another.
  $effect(() => {
    const id = spaceId;
    untrack(() => void load(id));
  });

  // The device's clock only REDRAWS (a unit drawn bookable or not, the opening notice); the server
  // decides every request on its own.
  $effect(() => {
    const opensAt = space?.opensAt ? Date.parse(space.opensAt) : null;
    return redrawEveryMinuteAndAt(opensAt, (now) => (nowMs = now));
  });

  async function load(id: string) {
    Log.d('BOOKINGS', `space page load space=${id}`);
    loading = true;
    loadError = '';
    space = null;
    slots = [];
    loaded = null;
    sheet = null;
    try {
      const loadedSpace = await getSpace(id);
      // A later navigation owns the page now: this answer is for a space no longer shown.
      if (id !== spaceId) return;
      space = loadedSpace;
      nowMs = Date.now();
      date = localDate(nowMs, loadedSpace.timeZone);
      resourceId = loadedSpace.resources[0]?.id ?? '';
      await Promise.all([readMine(), ensureSlots(true)]);
    } catch (e) {
      if (id !== spaceId) return;
      Log.i('BOOKINGS', `space read failed space=${id}: ${String(e)}`);
      loadError = describeBookingRefusal(e, m.common_load_error());
    } finally {
      if (id === spaceId) loading = false;
    }
  }

  /** What is true now: the grid and the reader's bookings, read again after an unknown outcome. */
  async function reread() {
    await Promise.all([readMine(), ensureSlots(true)]);
  }

  /** The reader's own bookings, by id: who holds what, and the private texts (D32). */
  async function readMine() {
    try {
      const rows = await myBookings();
      mine = new Map(rows.map((b) => [b.id, b]));
    } catch (e) {
      // The grid still reads; only the holder's cancel and the private texts wait for a reload.
      Log.i('BOOKINGS', `my bookings unavailable on the space page: ${String(e)}`);
    }
  }

  /** The last read asked for: an older answer arriving after it is for a week no longer shown. */
  let slotsRead = 0;

  /** The week shown, read when it is not already (or `force`d after a write). */
  async function ensureSlots(force = false) {
    if (!space) return;
    // Bumped on EVERY call, the cache hit included: a slow read for a week left behind must not
    // land once the view came back to a week already held.
    const mine = ++slotsRead;
    const { from, to } = weekReadRange(date);
    if (!force && loaded && loaded.from <= from && to <= loaded.to) return;
    slotsError = '';
    try {
      const read = await getSlots(space.id, from, to);
      if (mine !== slotsRead) return;
      slots = read;
      loaded = { from, to };
      nowMs = Date.now();
    } catch (e) {
      if (mine !== slotsRead) return;
      Log.i('BOOKINGS', `slots read failed ${from}..${to}: ${String(e)}`);
      slotsError = describeBookingRefusal(e, m.common_load_error());
    }
  }

  /** A whole week at a time: the same weekday on a phone, so the strip keeps its place. */
  function moveWeek(weeks: number) {
    date = addDays(date, weeks * WEEK_DAYS);
    void ensureSlots();
  }

  function chooseDate(next: string) {
    date = next;
    void ensureSlots();
  }

  /**
   * What tapping a unit opens: the reading of a taken unit, or the booking sheet of a free one - with
   * "block instead" for whoever may. A unit the device's clock puts outside the window still opens,
   * with a note: the server judges the START of the range, on its clock, and its answer is final.
   */
  function pick(resource: BookerResource, unit: SlotUnit, count = 1) {
    if (!space) return;
    if (unit.state !== 'free') {
      sheet = { kind: 'detail', resource, unit };
      return;
    }
    const units = unitsInOrder(slots, resource.id);
    const mayBlock = space.canManage || resource.linkedToMe;
    sheet = {
      kind: 'book',
      resource,
      run: freeRunFrom(units, unit, bookingUnitLimit(space)),
      initialCount: count,
      blockRun: mayBlock ? freeRunFrom(units, unit, BLOCK_LENGTH_CHOICES) : [],
      windowNote: windowRefusal(space, unit.startMs, nowMs) !== null,
    };
  }

  async function closeSheet(changed: boolean) {
    sheet = null;
    if (changed) await Promise.all([readMine(), ensureSlots(true)]);
  }
</script>

<PageContainer width="tool">
  <PageHeader
    title={space?.name ?? m.bookings_page_title()}
    subtitle={space?.description ?? undefined}
    crumbs={space
      ? [
          { label: m.bookings_page_title(), href: BOOKINGS_HREF },
          { label: space.name, href: spaceHref(space.id) },
        ]
      : undefined}
  >
    {#snippet actions()}
      {#if space}
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="ui-icon-button text-text-muted hover:text-text-main hover:bg-cn-border/30 rounded-lg"
            aria-label={m.bookings_space_copy_link()}
            title={m.bookings_space_copy_link()}
            onclick={() => space && void copyPublicShareLink(spaceHref(space.id))}
          >
            <Link size={18} />
          </button>
          <button
            type="button"
            class="ui-icon-button text-text-muted hover:text-text-main hover:bg-cn-border/30 rounded-lg"
            aria-label={m.qr_button()}
            title={m.qr_button()}
            onclick={() => (qrOpen = true)}
          >
            <QrCode size={18} />
          </button>
          {#if space.canManage}
            <a
              href={resolve(internalPath(spaceEditorHref(space.id)))}
              class="ui-icon-button text-text-muted hover:text-text-main hover:bg-cn-border/30 rounded-lg"
              aria-label={m.bookings_space_manage()}
              title={m.bookings_space_manage()}
            >
              <Pencil size={18} />
            </a>
          {/if}
        </div>
      {/if}
    {/snippet}
  </PageHeader>

  {#if space?.poster}
    <div class="mb-4">
      <SpacePoster poster={space.poster} alt={m.bookings_poster_alt({ name: space.name })} />
    </div>
  {/if}

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
  {:else if space.resources.length === 0}
    <EmptyState
      icon={CalendarDays}
      title={m.bookings_space_empty_title()}
      description={m.bookings_space_empty_desc()}
    />
  {:else}
    <div class="space-y-4">
      {#if space.resources.length > 1 && resource}
        <ColumnSelect
          resources={space.resources}
          value={resource.id}
          counts={freeCounts}
          onSelect={(id) => (resourceId = id)}
        />
      {/if}

      {#if notOpenYet}
        <p class="border-cn-border bg-cn-bg text-text-main rounded-xl border px-4 py-3 text-sm">
          {m.bookings_space_opens_at({ when: exactDate(notOpenYet) })}
        </p>
      {/if}
      {#if zoneDiffersFromDevice(space.timeZone, nowMs)}
        <p class="text-text-muted text-xs">
          {m.bookings_space_zone_note({ zone: space.timeZone })}
        </p>
      {/if}

      {#if slotsError}
        <p
          class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm"
          role="alert"
        >
          {slotsError}
        </p>
      {:else if resource && week && layout}
        {#if narrow}
          <DayStrip
            days={week.days}
            {date}
            {today}
            label={weekLabel}
            onSelect={chooseDate}
            onPrevious={() => moveWeek(-1)}
            onNext={() => moveWeek(1)}
          />
        {:else}
          <WeekBar
            label={weekLabel}
            away={!weekAll.includes(today)}
            onPrevious={() => moveWeek(-1)}
            onNext={() => moveWeek(1)}
            onToday={() => chooseDate(today)}
          />
        {/if}
        {#if layout.endMin === layout.startMin}
          <p class="text-text-muted py-8 text-center text-sm">
            {narrow ? m.bookings_day_empty() : m.bookings_week_empty()}
          </p>
        {:else}
          <SpaceGrid
            {space}
            {resource}
            {layout}
            mode={narrow ? 'day' : 'week'}
            {nowMs}
            onPick={pick}
          />
        {/if}
      {/if}

      <p class="text-text-muted text-xs">{m.bookings_space_no_notification_note()}</p>
    </div>
  {/if}
</PageContainer>

{#if space && sheet}
  {#if sheet.kind === 'book'}
    {@const s = sheet}
    <BookingSheet
      {space}
      resource={s.resource}
      run={s.run}
      initialCount={s.initialCount}
      windowNote={s.windowNote}
      onReread={reread}
      onBlockInstead={s.blockRun.length
        ? () => (sheet = { kind: 'block', resource: s.resource, run: s.blockRun })
        : undefined}
      onClose={closeSheet}
    />
  {:else if sheet.kind === 'block'}
    <BlockSheet
      {space}
      resource={sheet.resource}
      run={sheet.run}
      onReread={reread}
      onClose={closeSheet}
    />
  {:else}
    <UnitDetailSheet
      {space}
      resource={sheet.resource}
      unit={sheet.unit}
      mine={sheet.unit.state === 'booked' ? mine.get(sheet.unit.booking.id) : undefined}
      {nowMs}
      onClose={closeSheet}
    />
  {/if}
{/if}

{#if space}
  <QrCodeModal
    open={qrOpen}
    url={publicAppUrl(spaceHref(space.id))}
    label={space.name}
    intro={m.bookings_space_qr_intro()}
    onClose={() => (qrOpen = false)}
  />
{/if}
