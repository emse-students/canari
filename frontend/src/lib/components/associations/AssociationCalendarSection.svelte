<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import {
    listAssociationCalendarEvents,
    createAssociationCalendarEvent,
    updateAssociationCalendarEvent,
    deleteAssociationCalendarEvent,
    validateAssociationCalendarEvent,
    listAssociationLinkCandidates,
    aggregatedCalendarFeedIcsAbsoluteUrl,
    icsSubscriptionRangeISO,
    type AssociationCalendarEvent,
    type AssociationCalendarFeedEvent,
    type AssociationLinkCandidates,
  } from '$lib/associations/api';
  import {
    buildIcsCalendar,
    downloadTextFile,
    type AgendaExportEvent,
  } from '$lib/calendar/agendaExport';
  import MonthCalendarGridRich from '$lib/components/calendar/MonthCalendarGridRich.svelte';
  import CalendarDayEventsPanel from '$lib/components/calendar/CalendarDayEventsPanel.svelte';
  import CalendarEventDetailModal from '$lib/components/calendar/CalendarEventDetailModal.svelte';
  import CalendarSubscribeModal from '$lib/components/calendar/CalendarSubscribeModal.svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import {
    ChevronLeft,
    ChevronRight,
    CalendarPlus,
    Pencil,
    Trash2,
    CalendarSync,
    Download,
    Check,
  } from '@lucide/svelte';
  import EventFormModal from '$lib/components/calendar/EventFormModal.svelte';
  import {
    blankEventFormValues,
    eventFormValuesFrom,
    toCreatePayload,
    toUpdatePayload,
    type EventFormValues,
  } from '$lib/calendar/eventForm';
  import { pushHistoryOverlay, closeHistoryOverlayFromUi } from '$lib/utils/historyOverlayStack';
  import CalendarScheduleList from '$lib/components/calendar/CalendarScheduleList.svelte';
  import {
    SCHEDULE_AGENDA_QUERY,
    isScheduleAgendaViewport,
    onViewportChange,
  } from '$lib/utils/viewport';
  import { createEventPoster } from '$lib/calendar/eventPoster.svelte';
  import { Log } from '$lib/utils/Log';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  interface Props {
    associationId: string;
    /** Used in exported / subscribed ICS (`URL` field). */
    associationSlug?: string;
    canEdit?: boolean;
    /**
     * Whether the viewer may declare a school-wide `break` band. A band is a statement about the
     * SCHOOL, not about this association, so the control belongs to the authority that speaks for
     * it - the server refuses `kind` from anyone else (`assertMayDecideKind`), and offering a
     * field the API will refuse is how a control comes to look broken rather than forbidden.
     */
    canDeclareBreak?: boolean;
  }

  let {
    associationId,
    associationSlug,
    canEdit = false,
    canDeclareBreak = false,
  }: Props = $props();

  let events = $state<AssociationCalendarFeedEvent[]>([]);
  let loading = $state(true);
  let loadError = $state('');
  let focusDate = $state(new Date());
  let selectedDay = $state<number | null>(null);
  let detailEvent = $state<AssociationCalendarFeedEvent | null>(null);
  let detailModalOpen = $state(false);

  /** Visible month / year, locale-aware. */
  const titleMonth = $derived(
    new Intl.DateTimeFormat(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
      month: 'long',
      year: 'numeric',
    }).format(focusDate)
  );

  let modalOpen = $state(false);
  let eventModalHistoryClose: (() => void) | null = null;

  $effect(() => {
    if (modalOpen && !eventModalHistoryClose) {
      eventModalHistoryClose = () => dismissEventModal(true);
      pushHistoryOverlay(eventModalHistoryClose);
    } else if (!modalOpen) {
      eventModalHistoryClose = null;
    }
  });
  let editingId = $state<string | null>(null);
  let formValues = $state<EventFormValues>(blankEventFormValues());
  let linkCandidates = $state<AssociationLinkCandidates | null>(null);
  /** The poster of the event being edited - its state and its two endpoints, shared with the
   *  global agenda so the same control behaves the same on both surfaces. */
  const poster = createEventPoster({
    associationId: () => associationId,
    eventId: () => editingId,
    // The cards below carry the poster too, so the month is reloaded rather than patched.
    onChanged: loadMonth,
  });

  /**
   * What this surface may DECIDE, which is the only thing that ever differed between the two event
   * forms. A band speaks for the SCHOOL, so it needs the authority that speaks for it; a linked form
   * is this association's own, so it needs the right to edit this association.
   */
  const capabilities = $derived({ canSetKind: canDeclareBreak, canLinkForm: canEdit });

  let showSubscribeModal = $state(false);

  /** ~15 months window for feed subscription (server max ~18 months). */
  const calendarIcsUrl = $derived.by(() => {
    if (!browser) return '';
    const { from, to } = icsSubscriptionRangeISO();
    return aggregatedCalendarFeedIcsAbsoluteUrl({ from, to, associationId });
  });

  function associationPageUrl(): string {
    if (!browser || !associationSlug?.trim()) return '';
    return `${window.location.origin}/associations/${encodeURIComponent(associationSlug.trim())}`;
  }

  function toAgendaExport(ev: AssociationCalendarEvent): AgendaExportEvent {
    return {
      id: ev.id,
      title: ev.title,
      description: ev.description,
      startsAt: ev.startsAt,
      endsAt: ev.endsAt,
      sourceUrl: associationPageUrl() || undefined,
    };
  }

  function exportMonthIcs() {
    if (validatedEvents.length === 0) return;
    const y = focusDate.getFullYear();
    const mo = pad(focusDate.getMonth() + 1);
    downloadTextFile(
      `agenda-${associationSlug ?? associationId}-${y}-${mo}.ics`,
      buildIcsCalendar(validatedEvents.map(toAgendaExport)),
      'text/calendar;charset=utf-8'
    );
  }

  async function ensureLinkCandidates() {
    if (!canEdit) return;
    try {
      linkCandidates = await listAssociationLinkCandidates(associationId);
    } catch (e) {
      // An empty picker is what the editor sees; without this line it is also all anyone would
      // ever know about it.
      Log.d('[asso-calendar] link candidates failed', e);
      linkCandidates = { forms: [] };
    }
  }

  function pad(n: number) {
    return n < 10 ? `0${n}` : `${n}`;
  }

  function toDatetimeLocalValue(iso: string): string {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function monthRangeISO(d: Date): { from: string; to: string } {
    const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
    return { from: start.toISOString(), to: end.toISOString() };
  }

  async function loadMonth() {
    loading = true;
    loadError = '';
    try {
      const { from, to } = monthRangeISO(focusDate);
      events = await listAssociationCalendarEvents(associationId, {
        from,
        to,
        // Always requested: the backend only returns pending events to proposers / BDE / admins
        // (otherwise ignored), so they see them greyed-out on the calendar for ALL clubs,
        // not only the ones they edit.
        includePending: true,
        // Rejected events (management section) only for editors of this club.
        includeRejected: canEdit,
      });
    } catch (e) {
      loadError = m.common_load_error();
    } finally {
      loading = false;
    }
  }

  onMount(loadMonth);

  /**
   * A PHONE GETS A SCHEDULE LIST INSTEAD OF THE MONTH GRID - the same rule as `/calendar`, read
   * from the same predicate. Kept in step with rotations rather than fixed at mount: one window
   * can be both, and a device turned sideways must get the grid back.
   */
  let scheduleLayout = $state(false);
  onMount(() => {
    scheduleLayout = isScheduleAgendaViewport();
    return onViewportChange(SCHEDULE_AGENDA_QUERY, (narrow) => (scheduleLayout = narrow));
  });

  function prevMonth() {
    selectedDay = null;
    focusDate = new Date(focusDate.getFullYear(), focusDate.getMonth() - 1, 1);
    loadMonth();
  }

  function nextMonth() {
    selectedDay = null;
    focusDate = new Date(focusDate.getFullYear(), focusDate.getMonth() + 1, 1);
    loadMonth();
  }

  const validatedEvents = $derived(events.filter((e) => (e.status ?? 'validated') === 'validated'));
  const pendingEvents = $derived(events.filter((e) => e.status === 'pending'));
  const rejectedEvents = $derived(events.filter((e) => e.status === 'rejected'));

  // The calendar shows validated + pending events (pending rendered greyed-out via MonthCalendarGridRich),
  // never rejected ones (those only appear in the management section below).
  // THE OWNER TRAVELS WITH THE EVENT, AND THIS SECTION MUST NOT STAMP ITS OWN ASSOCIATION ONTO IT.
  // The list includes events this association only CO-OWNS: naming itself the owner put it in both
  // the owner slot and the co-owner slot of the same event, and the grid - keyed on that identity -
  // threw `each_key_duplicate` and crashed the page (prod, 2026-09-14).
  const feedEvents = $derived(events.filter((e) => (e.status ?? 'validated') !== 'rejected'));

  const sortedPendingEvents = $derived(
    [...pendingEvents].sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
    )
  );

  const sortedRejectedEvents = $derived(
    [...rejectedEvents].sort(
      (a, b) =>
        new Date(b.rejectedAt ?? b.createdAt).getTime() -
        new Date(a.rejectedAt ?? a.createdAt).getTime()
    )
  );

  function openEventDetail(ev: AssociationCalendarFeedEvent) {
    detailEvent = ev;
    detailModalOpen = true;
  }

  async function handleDetailDelete(id: string) {
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
    await removeEvent(id);
  }

  function handleDetailEdit(ev: AssociationCalendarFeedEvent) {
    const raw = events.find((e) => e.id === ev.id);
    if (raw) void openEdit(raw);
  }

  async function openCreate() {
    editingId = null;
    // The target is this association, and saying so is what keeps it out of its own co-owner list.
    formValues = { ...blankEventFormValues(), targetAssociationId: associationId };
    poster.set(null);
    modalOpen = true;
    await ensureLinkCandidates();
  }

  async function openEdit(ev: AssociationCalendarEvent) {
    editingId = ev.id;
    formValues = eventFormValuesFrom(ev);
    poster.set(ev.imageUrl ?? null);
    modalOpen = true;
    await ensureLinkCandidates();
  }

  function dismissEventModal(fromHistory = false) {
    modalOpen = false;
    if (fromHistory) {
      eventModalHistoryClose = null;
      return;
    }
    if (eventModalHistoryClose) {
      const h = eventModalHistoryClose;
      eventModalHistoryClose = null;
      closeHistoryOverlayFromUi(h);
    }
  }

  function closeModal() {
    dismissEventModal(false);
  }

  /**
   * The endpoint, which is the ONE thing the two event surfaces genuinely disagree about. Validation,
   * the saving flag and the sentence a refusal reads as all belong to the modal.
   */
  async function submitEvent(values: EventFormValues) {
    if (editingId) {
      await updateAssociationCalendarEvent(
        associationId,
        editingId,
        toUpdatePayload(values, capabilities)
      );
    } else {
      await createAssociationCalendarEvent(associationId, toCreatePayload(values, capabilities));
    }
    dismissEventModal(false);
    await loadMonth();
  }

  async function removeEvent(id: string) {
    if (
      !(await showConfirm(m.asso_calendar_confirm_delete(), {
        danger: true,
        confirmLabel: m.common_delete_button(),
      }))
    )
      return;
    try {
      await deleteAssociationCalendarEvent(associationId, id);
      await loadMonth();
    } catch (e) {
      loadError = m.common_delete_error();
    }
  }

  async function validateEvent(id: string) {
    try {
      await validateAssociationCalendarEvent(associationId, id);
      await loadMonth();
    } catch (e) {
      loadError = m.common_generic_error_label();
    }
  }

  function formatEventRange(ev: AssociationCalendarEvent): string {
    const locale = getLocale() === 'en' ? 'en-US' : 'fr-FR';
    const s = new Date(ev.startsAt);
    const fmt = new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    if (!ev.endsAt) return fmt.format(s);
    const e = new Date(ev.endsAt);
    return `${fmt.format(s)} - ${new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(e)}`;
  }
</script>

<div class="space-y-5">
  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <div>
      <h2 class="text-text-main text-lg font-bold tracking-tight">{m.asso_tab_calendar()}</h2>
      <p class="text-text-muted text-sm">
        {m.asso_calendar_subtitle()}
        {#if canEdit}
          {m.asso_calendar_pending_note()}
        {/if}
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
      <button
        type="button"
        onclick={() => (showSubscribeModal = true)}
        class="border-cn-border text-text-main hover:bg-cn-bg inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors"
      >
        <CalendarSync size={18} />
        {m.asso_calendar_subscribe_button()}
      </button>
      <button
        type="button"
        onclick={exportMonthIcs}
        disabled={loading || validatedEvents.length === 0}
        class="border-cn-border text-text-main hover:bg-cn-bg inline-flex items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-40"
      >
        <Download size={18} />
        {m.asso_calendar_export_ics_button()}
      </button>
      {#if canEdit}
        <button
          type="button"
          onclick={openCreate}
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold shadow-sm transition-colors"
        >
          <CalendarPlus size={18} />
          {m.asso_calendar_propose_event_button()}
        </button>
      {/if}
    </div>
  </div>

  <div class="flex items-center justify-between gap-2">
    <button
      type="button"
      onclick={prevMonth}
      class="ui-icon-button border-cn-border text-text-main hover:bg-cn-bg rounded-xl border transition-colors"
      aria-label={m.asso_calendar_prev_month_label()}
    >
      <ChevronLeft size={20} />
    </button>
    <p class="text-text-main flex-1 text-center text-base font-bold capitalize">{titleMonth}</p>
    <button
      type="button"
      onclick={nextMonth}
      class="ui-icon-button border-cn-border text-text-main hover:bg-cn-bg rounded-xl border transition-colors"
      aria-label={m.asso_calendar_next_month_label()}
    >
      <ChevronRight size={20} />
    </button>
  </div>

  {#if loadError}
    <div class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-4 py-3 text-sm">
      {loadError}
    </div>
  {/if}

  {#if scheduleLayout}
    <!-- THE PHONE GETS THE SAME ANSWER AS `/calendar`, AND HAD NONE AT ALL. Seven columns of 48px
         say which days exist and nothing about what is on them, and this section drew that grid on
         every screen: the association's agenda was unreadable on the device most people open it on,
         while the global one had been a schedule list since 2026-09-09. `CalendarScheduleList`
         takes the month out of the events themselves, so there is no selected day to carry and no
         day panel to place. -->
    <CalendarScheduleList
      {focusDate}
      events={feedEvents}
      {loading}
      ownAssociationId={associationId}
      onEventClick={openEventDetail}
    />
  {:else}
    <MonthCalendarGridRich {focusDate} events={feedEvents} {loading} bind:selectedDay />

    <CalendarDayEventsPanel
      {focusDate}
      {selectedDay}
      events={feedEvents}
      ownAssociationId={associationId}
      onEventClick={openEventDetail}
    />
  {/if}

  <CalendarEventDetailModal
    open={detailModalOpen}
    event={detailEvent}
    {canEdit}
    showAssociation={detailEvent !== null && detailEvent.associationId !== associationId}
    onClose={() => {
      detailModalOpen = false;
      detailEvent = null;
    }}
    onEdit={handleDetailEdit}
    onDelete={handleDetailDelete}
  />

  {#if canEdit && !loading && sortedPendingEvents.length > 0}
    <div class="space-y-3">
      <h3 class="text-amber-warn text-sm font-bold tracking-wide uppercase">
        {m.asso_calendar_pending_section_title({ count: sortedPendingEvents.length })}
      </h3>
      {#each sortedPendingEvents as ev (ev.id)}
        <div
          class="border-amber-warn/30 bg-amber-warn/10 flex flex-col gap-3 rounded-2xl border px-4 py-3 sm:flex-row sm:items-start"
        >
          <div class="min-w-0 flex-1">
            <p class="text-text-main flex flex-wrap items-center gap-2 font-bold">
              {ev.title}
              <span
                class="text-amber-warn bg-amber-warn/20 text-2xs rounded-full px-2 py-0.5 font-bold tracking-wide uppercase"
              >
                {m.asso_calendar_pending_badge()}
              </span>
            </p>
            <p class="text-text-muted mt-0.5 text-xs">{formatEventRange(ev)}</p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onclick={() => validateEvent(ev.id)}
              class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-1 rounded-xl px-3 py-2 text-xs font-bold"
              title={m.asso_calendar_validate_title()}
            >
              <Check size={14} />
              {m.common_validate_button()}
            </button>
            <button
              type="button"
              onclick={() => openEdit(ev)}
              class="ui-icon-button border-cn-border hover:bg-cn-bg text-text-main rounded-xl border"
              title={m.common_edit_label()}
            >
              <Pencil size={16} />
            </button>
            <button
              type="button"
              onclick={() => removeEvent(ev.id)}
              class="ui-icon-button border-red-err/30 text-red-err hover:bg-red-err/10 rounded-xl border"
              title={m.common_delete_button()}
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if canEdit && !loading && sortedRejectedEvents.length > 0}
    <div class="space-y-3">
      <h3 class="text-red-err text-sm font-bold tracking-wide uppercase">
        {m.asso_calendar_rejected_section_title({ count: sortedRejectedEvents.length })}
      </h3>
      {#each sortedRejectedEvents as ev (ev.id)}
        <div
          class="border-red-err/30 bg-red-err/10 flex flex-col gap-3 rounded-2xl border px-4 py-3 sm:flex-row sm:items-start dark:bg-red-950/20"
        >
          <div class="min-w-0 flex-1">
            <p class="text-text-main flex flex-wrap items-center gap-2 font-bold">
              {ev.title}
              <span
                class="text-red-err bg-red-err/20 text-2xs rounded-full px-2 py-0.5 font-bold tracking-wide uppercase"
              >
                {m.asso_calendar_rejected_badge()}
              </span>
            </p>
            <p class="text-text-muted mt-0.5 text-xs">{formatEventRange(ev)}</p>
            {#if ev.rejectionReason?.trim()}
              <p class="text-red-err mt-1 text-xs">
                {m.asso_calendar_rejection_reason_prefix()}{ev.rejectionReason}
              </p>
            {/if}
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onclick={() => removeEvent(ev.id)}
              class="ui-icon-button border-red-err/30 text-red-err hover:bg-red-err/10 rounded-xl border"
              title={m.common_delete_button()}
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<EventFormModal
  open={modalOpen}
  heading={editingId ? m.asso_calendar_modal_edit_title() : m.asso_calendar_modal_create_title()}
  note={editingId ? null : m.asso_calendar_modal_pending_note()}
  editing={!!editingId}
  bind:values={formValues}
  {capabilities}
  linkableForms={linkCandidates?.forms ?? null}
  poster={poster.controls}
  submitLabel={m.common_save_button()}
  savingLabel={m.asso_calendar_saving_label()}
  onSubmit={submitEvent}
  onClose={closeModal}
/>

<CalendarSubscribeModal
  open={showSubscribeModal}
  onClose={() => (showSubscribeModal = false)}
  icsUrl={calendarIcsUrl}
  intro={m.asso_calendar_subscribe_intro()}
/>
