<script lang="ts">
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import { onMount } from 'svelte';
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    listAggregatedCalendarFeed,
    listAssociations,
    listPendingCalendarEvents,
    listMyAssociations,
    listAssociationLinkCandidates,
    createAssociationCalendarEvent,
    updateAssociationCalendarEvent,
    deleteAssociationCalendarEvent,
    hasPermissionFlag,
    findBdeAssociationWithFlag,
    AssociationPermissionFlag,
    aggregatedCalendarFeedIcsAbsoluteUrl,
    icsSubscriptionRangeISO,
    type AssociationCalendarFeedEvent,
    type Association,
  } from '$lib/associations/api';
  import { isGlobalAdmin } from '$lib/stores/user';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import Card from '$lib/components/ui/Card.svelte';
  import MonthCalendarGridRich from '$lib/components/calendar/MonthCalendarGridRich.svelte';
  import CalendarDayEventsPanel from '$lib/components/calendar/CalendarDayEventsPanel.svelte';
  import CalendarScheduleList from '$lib/components/calendar/CalendarScheduleList.svelte';
  import CalendarEventDetailModal from '$lib/components/calendar/CalendarEventDetailModal.svelte';
  import CalendarSubscribeModal from '$lib/components/calendar/CalendarSubscribeModal.svelte';
  import AssociationOptions from '$lib/components/associations/AssociationOptions.svelte';
  import EventFormModal from '$lib/components/calendar/EventFormModal.svelte';
  import {
    blankEventFormValues,
    eventFormValuesFrom,
    toCreatePayload,
    toUpdatePayload,
    type EventFormValues,
  } from '$lib/calendar/eventForm';
  import {
    ChevronLeft,
    ChevronRight,
    CalendarCheck,
    CalendarPlus,
    ShieldAlert,
    FileDown,
  } from '@lucide/svelte';
  import { createEventPoster } from '$lib/calendar/eventPoster.svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';
  import {
    SCHEDULE_AGENDA_QUERY,
    isScheduleAgendaViewport,
    onViewportChange,
  } from '$lib/utils/viewport';

  /**
   * A PHONE GETS A SCHEDULE LIST INSTEAD OF THE MONTH GRID (user, 2026-09-09).
   *
   * Read at mount and kept in step with rotations rather than fixed once: the same window can be
   * both, and a device turned sideways must get the grid back rather than keep a layout chosen for
   * the width it used to have. `false` under SSR is the desktop answer by design - the mount that
   * follows corrects it.
   */
  let scheduleLayout = $state(false);

  let focusDate = $state(new Date());
  let associations = $state<Association[]>([]);
  let filterAssociationId = $state('');
  let events = $state<AssociationCalendarFeedEvent[]>([]);
  let loading = $state(true);
  let loadError = $state('');

  const titleMonth = $derived(
    new Intl.DateTimeFormat(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
      month: 'long',
      year: 'numeric',
    }).format(focusDate)
  );

  function monthRangeISO(d: Date): { from: string; to: string } {
    const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
    return { from: start.toISOString(), to: end.toISOString() };
  }

  async function loadAssociations() {
    try {
      const list = await listAssociations();
      // Sorted for `associations[0]`, the default deposit target - NOT for the two selects, whose
      // order is `AssociationOptions`. A default that moved with the API response order would be
      // a different association on two loads of the same page.
      associations = [...list].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    } catch {
      associations = [];
    }
  }

  async function loadMonth() {
    loading = true;
    loadError = '';
    try {
      const { from, to } = monthRangeISO(focusDate);
      // includePending: server only returns pending events to submitters / BDE admins /
      // global admins; the flag is always sent and the server filters accordingly.
      events = await listAggregatedCalendarFeed({
        from,
        to,
        associationId: filterAssociationId || undefined,
        includePending: true,
      });
    } catch {
      // The fallback this line already declared is the right answer; the server's own sentence is
      // English and was winning the ternary every time.
      loadError = m.common_generic_error_label();
      events = [];
    } finally {
      loading = false;
    }
  }

  function applyFilterToUrl() {
    const path = page.url.pathname;
    if (filterAssociationId.trim()) {
      void goto(`${path}?association=${encodeURIComponent(filterAssociationId.trim())}`, {
        replaceState: true,
        keepFocus: true,
        noScroll: true,
      });
    } else {
      void goto(path, { replaceState: true, keepFocus: true, noScroll: true });
    }
  }

  function onFilterSelectChange() {
    selectedDay = null;
    applyFilterToUrl();
    void loadMonth();
  }

  function prevMonth() {
    focusDate = new Date(focusDate.getFullYear(), focusDate.getMonth() - 1, 1);
    selectedDay = null;
    void loadMonth();
  }

  function nextMonth() {
    focusDate = new Date(focusDate.getFullYear(), focusDate.getMonth() + 1, 1);
    selectedDay = null;
    void loadMonth();
  }

  onMount(() => {
    scheduleLayout = isScheduleAgendaViewport();
    return onViewportChange(SCHEDULE_AGENDA_QUERY, (narrow) => (scheduleLayout = narrow));
  });

  onMount(async () => {
    filterAssociationId = page.url.searchParams.get('association')?.trim() ?? '';
    await loadAssociations();
    await loadMonth();
    if (isGlobalAdmin()) {
      canModerateAgenda = true;
      canDepositEvent = true;
    } else {
      try {
        const mine = await listMyAssociations();
        canModerateAgenda = mine.some((a) => a.isAdmin);
        // A BDE validator (VALIDATE_EVENTS in a BDE association) may deposit on behalf of
        // any association; we keep their BDE association as the authorisation :id.
        const authority = findBdeAssociationWithFlag(
          mine,
          AssociationPermissionFlag.VALIDATE_EVENTS
        );
        depositAuthorityAssoId = authority?.id ?? '';
        canDepositEvent = !!authority;
        proposeAssocIds = new Set(
          mine
            .filter((a) =>
              hasPermissionFlag(a.permissions ?? 0, AssociationPermissionFlag.PROPOSE_EVENT)
            )
            .map((a) => a.id)
        );
      } catch {
        canModerateAgenda = false;
        canDepositEvent = false;
        proposeAssocIds = new Set();
      }
    }
    if (canModerateAgenda) {
      try {
        const pending = await listPendingCalendarEvents();
        pendingCount = pending.events.length;
      } catch {
        pendingCount = 0;
      }
    }
  });

  afterNavigate((n) => {
    if (!n.to) return;
    const path = n.to.url.pathname;
    if (!path.startsWith('/calendar')) return;
    const next = n.to.url.searchParams.get('association')?.trim() ?? '';
    if (next !== filterAssociationId) {
      filterAssociationId = next;
      void loadMonth();
    }
  });

  let showSubscribeModal = $state(false);

  /** https:// URL to the aggregated .ics feed; `CalendarSubscribeModal` derives webcal/Google variants. */
  const calendarIcsUrl = $derived.by(() => {
    if (typeof window === 'undefined') return '';
    const { from, to } = icsSubscriptionRangeISO();
    return aggregatedCalendarFeedIcsAbsoluteUrl({
      from,
      to,
      associationId: filterAssociationId || undefined,
    });
  });

  const sortedEvents = $derived(
    [...events].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
  );

  function openEventDetail(ev: AssociationCalendarFeedEvent) {
    detailEvent = ev;
    detailModalOpen = true;
  }

  let canModerateAgenda = $state(false);
  let pendingCount = $state(0);
  let selectedDay = $state<number | null>(null);
  let detailEvent = $state<AssociationCalendarFeedEvent | null>(null);
  let detailModalOpen = $state(false);

  // ── Editing from the global agenda ────────────────────────────────────────
  // Mirrors the server rule on PATCH/DELETE `/associations/:id/events/:eventId`: a global admin
  // or a BDE VALIDATE_EVENTS holder may touch any association's event, anyone else needs
  // PROPOSE_EVENT in the association that owns it. Without this the buttons only existed on the
  // owning association's page, so touching an event meant first finding who filed it.

  /** Associations where the user holds PROPOSE_EVENT (empty for a global admin - they bypass it). */
  let proposeAssocIds = $state<Set<string>>(new Set());

  function canEditEvent(ev: AssociationCalendarFeedEvent): boolean {
    return canDepositEvent || proposeAssocIds.has(ev.associationId);
  }

  const canEditDetailEvent = $derived(detailEvent ? canEditEvent(detailEvent) : false);

  function handleDetailEdit(ev: AssociationCalendarFeedEvent) {
    detailModalOpen = false;
    openEditEvent(ev);
  }

  async function handleDetailDelete(id: string) {
    const target = detailEvent;
    if (!target) return;
    if (
      !(await showConfirm(m.asso_calendar_confirm_delete(), {
        danger: true,
        confirmLabel: m.common_delete_button(),
      }))
    ) {
      return;
    }
    detailModalOpen = false;
    detailEvent = null;
    try {
      await deleteAssociationCalendarEvent(target.associationId, id);
      await loadMonth();
    } catch {
      loadError = m.common_generic_error_label();
    }
  }

  // ── Event deposit (global admins + BDE validators) ────────────────────────
  // These users can auto-validate events. A global admin posts directly on the
  // chosen association; a BDE validator posts via their BDE association and
  // redirects with `targetAssocId`.

  /** Whether the current user may deposit an auto-validated event for any association. */
  let canDepositEvent = $state(false);
  /** BDE association id (with VALIDATE_EVENTS) used as the URL :id for non-global-admins. */
  let depositAuthorityAssoId = $state('');
  let depositModalOpen = $state(false);
  let depositValues = $state<EventFormValues>(blankEventFormValues());
  /** Non-null when the modal is editing an existing event instead of depositing a new one. */
  let editingEventId = $state<string | null>(null);
  /** Owning association of the event being edited, shown read-only (an event never changes owner). */
  let editingOwnerName = $state('');

  /**
   * This surface chooses WHO an event belongs to, and nothing else. `kind`, a linked form and the
   * poster are the association's own to decide, and a capability left unset is what keeps them out
   * of the payload rather than a comment asking the next reader to remember.
   */
  /**
   * WHAT THIS SURFACE MAY DECIDE - and it was granting itself the least of the three.
   *
   * `canSetKind` follows `canDepositEvent`, which is exactly `mayValidate` on the server
   * (`assertMayDecideKind`): a global admin or a BDE `VALIDATE_EVENTS` holder. Anyone else reaching
   * this form is a proposer EDITING their own association's event, and the server would refuse the
   * field - so it is not offered, rather than offered and refused.
   *
   * `canLinkForm` needs the forms of the TARGET association, and `GET :id/link-candidates` wants
   * `PROPOSE_EVENT` on that association. That is knowable here, from the list already loaded, so
   * the control appears only where the request would succeed instead of being sent to find out.
   */
  const capabilities = $derived({
    canTargetAnotherAssociation: true,
    canSetKind: canDepositEvent,
    canLinkForm: mayLinkFormOn(depositValues.targetAssociationId),
  });

  /** Whether the viewer may list - and therefore link - the forms of `associationId`. */
  function mayLinkFormOn(associationId: string): boolean {
    if (!associationId) return false;
    return isGlobalAdmin() || proposeAssocIds.has(associationId);
  }

  /**
   * The target's forms, refetched when the target changes: the picker is per-association, and this
   * surface is the one that can move an event from one association to another mid-form.
   */
  let linkCandidates = $state<{ id: string; title: string }[] | null>(null);
  let linkCandidatesFor = $state('');

  async function ensureLinkCandidates(associationId: string) {
    if (linkCandidatesFor === associationId) return;
    linkCandidatesFor = associationId;
    linkCandidates = null;
    if (!mayLinkFormOn(associationId)) return;
    try {
      const loaded = await listAssociationLinkCandidates(associationId);
      if (linkCandidatesFor === associationId) linkCandidates = loaded.forms;
    } catch (e) {
      // The right was checked before the call, so a refusal here is the transport or a rule that
      // moved - either way the picker is empty and the reason must not vanish with it.
      Log.d('[calendar] link candidates failed', e);
    }
  }

  // The target is chosen inside the modal, so the candidate list follows the VALUE rather than the
  // opening: picking another association mid-form must repopulate the picker under it.
  $effect(() => {
    if (depositModalOpen) void ensureLinkCandidates(depositValues.targetAssociationId);
  });

  /**
   * The poster, on the same terms as the association's own page. It addresses an existing row, so
   * the owning association is the event's - `targetAssociationId` holds it while editing.
   */
  const poster = createEventPoster({
    associationId: () => depositValues.targetAssociationId,
    eventId: () => editingEventId,
    onChanged: loadMonth,
  });

  function openDeposit() {
    editingEventId = null;
    editingOwnerName = '';
    depositValues = {
      ...blankEventFormValues(),
      targetAssociationId: filterAssociationId || associations[0]?.id || '',
    };
    poster.set(null);
    depositModalOpen = true;
  }

  function openEditEvent(ev: AssociationCalendarFeedEvent) {
    editingEventId = ev.id;
    editingOwnerName = ev.associationName;
    depositValues = eventFormValuesFrom(ev);
    poster.set(ev.imageUrl ?? null);
    depositModalOpen = true;
  }

  /**
   * The endpoint, which is the ONE thing this surface decides that the association's page does not.
   * Validation, the saving flag and the sentence a refusal reads as belong to the modal.
   */
  async function submitEvent(values: EventFormValues) {
    const target = values.targetAssociationId;
    if (editingEventId) {
      // The event keeps its owner, so the URL :id is the owning association.
      await updateAssociationCalendarEvent(
        target,
        editingEventId,
        toUpdatePayload(values, capabilities)
      );
    } else {
      // Global admin: posts directly on the target association (auto-validated server-side).
      // BDE validator: posts through their BDE association with targetAssocId toward the target.
      const urlAssocId = isGlobalAdmin() ? target : depositAuthorityAssoId;
      await createAssociationCalendarEvent(urlAssocId, {
        ...toCreatePayload(values, capabilities),
        ...(isGlobalAdmin() ? {} : { targetAssocId: target }),
      });
    }
    depositModalOpen = false;
    detailEvent = null;
    await loadMonth();
  }

  const exportHref = $derived.by(() => {
    const monthKey = `${focusDate.getFullYear()}-${String(focusDate.getMonth() + 1).padStart(2, '0')}`;
    const parts = [`month=${encodeURIComponent(monthKey)}`];
    if (filterAssociationId) parts.push(`association=${encodeURIComponent(filterAssociationId)}`);
    return `/calendar/export?${parts.join('&')}`;
  });
</script>

<!--
  NO BACK LINK AND NO LOGO (user, 2026-09-09).

  The agenda is a top-level destination reached from the navigation, not a sub-page of
  `/associations`, so a back arrow to that route sent the reader somewhere they had not come from.
  The `CalendarDays` glyph beside the word "Agenda" went with it, along with the shop's and the
  dashboard's - the navigation already carries those icons.
-->
<PageContainer width="grid">
  <!-- The subtitle is an instruction, so it has to be true of the view actually on screen: the
       schedule list has no day to click, and telling a reader to click one is worse than saying
       nothing. -->
  <PageHeader
    title={m.calendar_heading()}
    subtitle={scheduleLayout ? m.calendar_subtitle_schedule() : m.calendar_subtitle()}
  >
    {#snippet actions()}
      {#if canDepositEvent}
        <button
          type="button"
          onclick={openDeposit}
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex shrink-0 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold shadow-sm transition-colors"
        >
          <CalendarPlus size={18} />
          {m.calendar_deposit_button()}
        </button>
      {/if}
    {/snippet}
  </PageHeader>

  <div class="space-y-6">
    {#if canModerateAgenda}
      <a
        href="/admin/agenda"
        class="border-amber-warn/30 bg-amber-warn/10 hover:border-amber-warn/40 flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 transition-colors"
      >
        <span
          class="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-100"
        >
          <ShieldAlert size={18} />
          {m.calendar_moderate_label()}
          {#if pendingCount > 0}
            <span class="text-2xs text-cn-ink rounded-full bg-amber-500 px-2 py-0.5 font-bold">
              {pendingCount}
            </span>
          {/if}
        </span>
        <span class="text-xs text-amber-800/80 dark:text-amber-200/80"
          >{m.calendar_moderate_open()} →</span
        >
      </a>
    {/if}

    <!-- THE CONTROLS ARE SNIPPETS BECAUSE THEY HAVE TWO HOMES, NOT TO SAVE TYPING. The phone
         keeps them in a bar above a list; the desktop puts them in the left rail beside the
         month. Copying them would be two month navigations that can disagree about what `prevMonth`
         resets, which is exactly the class of bug `selectedDay = null` in three places already
         invites. -->
    {#snippet monthNav()}
      <div class="flex items-center gap-2">
        <button
          type="button"
          onclick={prevMonth}
          class="ui-icon-button border-cn-border text-text-main rounded-xl border transition-colors hover:bg-(--cn-surface)"
          aria-label={m.calendar_prev_month()}
        >
          <ChevronLeft size={20} />
        </button>
        <span class="text-text-main flex-1 text-center text-sm font-bold capitalize">
          {titleMonth}
        </span>
        <button
          type="button"
          onclick={nextMonth}
          class="ui-icon-button border-cn-border text-text-main rounded-xl border transition-colors hover:bg-(--cn-surface)"
          aria-label={m.calendar_next_month()}
        >
          <ChevronRight size={20} />
        </button>
      </div>
    {/snippet}

    {#snippet associationFilter()}
      <label class="text-text-muted flex flex-col gap-1 text-xs font-semibold sm:min-w-56">
        {m.calendar_filter_label()}
        <select
          class="border-cn-border text-text-main rounded-xl border bg-(--cn-surface) px-3 py-2 text-sm font-medium"
          bind:value={filterAssociationId}
          onchange={onFilterSelectChange}
        >
          <option value="">{m.calendar_filter_all()}</option>
          <AssociationOptions {associations} />
        </select>
      </label>
    {/snippet}

    {#snippet exportActions()}
      <a
        href={exportHref}
        class="border-cn-border text-text-main hover:bg-cn-bg inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border bg-(--cn-surface) px-4 py-2.5 text-sm font-bold transition-colors"
      >
        <FileDown size={18} />
        {m.calendar_export_pdf()}
      </a>
      <button
        type="button"
        onclick={() => (showSubscribeModal = true)}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover hidden shrink-0 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold shadow-sm transition-colors sm:inline-flex"
      >
        <CalendarCheck size={18} />
        {m.calendar_subscribe()}
      </button>
    {/snippet}

    {#snippet loadErrorBox()}
      <div class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm">
        {loadError}
      </div>
    {/snippet}

    {#if scheduleLayout}
      <!-- THE PHONE IS UNCHANGED. One list, no grid: seven columns of 48px say which days exist
           and nothing about what is on them. `CalendarScheduleList` takes the month out of the
           feed itself, so there is no selected day to carry here, and no day panel to place. -->
      <Card class="space-y-4 p-4 sm:p-5">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {@render monthNav()}
          {@render associationFilter()}
        </div>
        <div class="border-cn-border/60 flex flex-wrap justify-end gap-2 border-t pt-4">
          {@render exportActions()}
        </div>
      </Card>

      {#if loadError}
        {@render loadErrorBox()}
      {:else}
        <CalendarScheduleList
          {focusDate}
          events={sortedEvents}
          {loading}
          onEventClick={openEventDetail}
        />
      {/if}
    {:else}
      <!-- THE SHAPE IS `/calendar/export`'S, DELIBERATELY AND EXACTLY (user, 2026-09-10:
           *"On pourrait reprendre exactement les formes de /calendar/export pour /calendar (pour
           la version web du moins), avec le calendrier a droite et le panneau a gauche"*).

           It is also Google Agenda's, which is the reference this page was measured against: a
           fixed rail on the left, the month taking whatever is left. Stacking instead - a
           full-width control bar, then the month, then the selected day BELOW it - is what made
           the page read wide, because the month then had the whole 1600px column to spread seven
           columns across, and the day you clicked was under the fold.

           `minmax(0,1fr)` AND NOT `1fr`: a track written `1fr` is `minmax(auto,1fr)`, and `auto`
           as a minimum means the track may not shrink below its content's min-content width -
           the rule that made this page's sibling overflow its column in the same sweep. The
           month grid has seven columns of its own and a min-content width worth respecting, so
           the floor is stated as zero and `min-w-0` repeats it on the flex/grid child. -->
      <div class="grid grid-cols-1 items-start gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        <div
          class="border-cn-border bg-cn-surface space-y-5 rounded-2xl border p-5 shadow-sm lg:sticky lg:top-4"
        >
          {@render monthNav()}

          <hr class="border-cn-border/60" />

          {@render associationFilter()}

          <hr class="border-cn-border/60" />

          <div class="flex flex-col gap-2">
            {@render exportActions()}
          </div>

          {#if !loadError && !(!loading && sortedEvents.length === 0)}
            <hr class="border-cn-border/60" />
            <!-- The selected day belongs BESIDE the month it was clicked in, not under it. The
                 panel renders its own "pick a day" state when nothing is selected, so the rail
                 never collapses as you navigate. -->
            <CalendarDayEventsPanel
              {focusDate}
              {selectedDay}
              events={sortedEvents}
              onEventClick={openEventDetail}
            />
          {/if}
        </div>

        <div class="min-w-0 space-y-4">
          {#if loadError}
            {@render loadErrorBox()}
          {:else}
            <MonthCalendarGridRich {focusDate} events={sortedEvents} {loading} bind:selectedDay />

            {#if !loading && sortedEvents.length === 0}
              <Card class="text-text-muted p-8 text-center text-sm">{m.calendar_empty()}</Card>
            {/if}
          {/if}
        </div>
      </div>
    {/if}

    <CalendarEventDetailModal
      open={detailModalOpen}
      event={detailEvent}
      canEdit={canEditDetailEvent}
      onClose={() => {
        detailModalOpen = false;
        detailEvent = null;
      }}
      onEdit={handleDetailEdit}
      onDelete={handleDetailDelete}
    />

    <CalendarSubscribeModal
      open={showSubscribeModal}
      onClose={() => (showSubscribeModal = false)}
      icsUrl={calendarIcsUrl}
      intro={m.calendar_subscribe_intro()}
    />
  </div>
</PageContainer>

<EventFormModal
  open={depositModalOpen}
  heading={editingEventId ? m.asso_calendar_modal_edit_title() : m.calendar_deposit_modal_title()}
  note={editingEventId
    ? m.calendar_edit_owner_note({ association: editingOwnerName })
    : m.calendar_deposit_immediate_note()}
  editing={!!editingEventId}
  bind:values={depositValues}
  {capabilities}
  {associations}
  linkableForms={linkCandidates}
  poster={poster.controls}
  submitLabel={editingEventId ? m.common_save_button() : m.calendar_deposit_publish()}
  savingLabel={editingEventId ? m.asso_calendar_saving_label() : m.calendar_deposit_publishing()}
  onSubmit={submitEvent}
  onClose={() => (depositModalOpen = false)}
/>
