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
    uploadCalendarEventImage,
    deleteCalendarEventImage,
    aggregatedCalendarFeedIcsAbsoluteUrl,
    icsSubscriptionRangeISO,
    type AssociationCalendarEvent,
    type AssociationCalendarEventKind,
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
  import { portal } from '$lib/actions/portal';
  import {
    ChevronLeft,
    ChevronRight,
    CalendarPlus,
    Pencil,
    Trash2,
    Link2,
    CalendarSync,
    Download,
    Check,
    ImagePlus,
    X,
  } from '@lucide/svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import CoOwnerPicker from '$lib/components/calendar/CoOwnerPicker.svelte';
  import { SvelteDate } from 'svelte/reactivity';
  import { pushHistoryOverlay, closeHistoryOverlayFromUi } from '$lib/utils/historyOverlayStack';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  interface Props {
    associationId: string;
    /** Used in exported / subscribed ICS (`URL` field). */
    associationSlug?: string;
    associationName?: string;
    associationLogoUrl?: string | null;
    canEdit?: boolean;
    /** Hex color of this association for calendar cell gradient (e.g. "#e83e8c"). */
    associationColor?: string | null;
  }

  let {
    associationId,
    associationSlug,
    associationName = '',
    associationLogoUrl = null,
    canEdit = false,
    associationColor = null,
  }: Props = $props();

  let events = $state<AssociationCalendarEvent[]>([]);
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
  let formTitle = $state('');
  /** `event` (a card) or `break` (a full-day background band for vacations / no-course days). */
  let formKind = $state<AssociationCalendarEventKind>('event');
  let formDescription = $state('');
  /** datetime-local strings */
  let formStart = $state('');
  let formEnd = $state('');
  let saving = $state(false);
  let formError = $state('');
  let linkCandidates = $state<AssociationLinkCandidates | null>(null);
  /** Selected form ID for modal (empty = none). */
  let formLinkedFormId = $state('');
  /** Current poster image URL for the event being edited (null = none). */
  let formImageUrl = $state<string | null>(null);
  let uploadingImage = $state(false);

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
    } catch {
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
      loadError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      loading = false;
    }
  }

  onMount(loadMonth);

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

  /** Maps association events to the feed shape expected by the rich calendar grid. */
  function toFeedEvent(ev: AssociationCalendarEvent): AssociationCalendarFeedEvent {
    return {
      ...ev,
      associationName,
      associationSlug: associationSlug ?? '',
      associationColor: associationColor ?? null,
      associationLogoUrl: associationLogoUrl ?? null,
    };
  }

  // The calendar shows validated + pending events (pending rendered greyed-out via MonthCalendarGridRich),
  // never rejected ones (those only appear in the management section below).
  const feedEvents = $derived(
    events.filter((e) => (e.status ?? 'validated') !== 'rejected').map(toFeedEvent)
  );

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

  /** IDs of co-owner associations selected for the current form. */
  let formCoOwnerIds = $state<string[]>([]);

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
    formTitle = '';
    formKind = 'event';
    formDescription = '';
    formLinkedFormId = '';
    formCoOwnerIds = [];
    formImageUrl = null;
    const now = new SvelteDate();
    now.setMinutes(0, 0, 0);
    formStart = toDatetimeLocalValue(now.toISOString());
    formEnd = '';
    formError = '';
    modalOpen = true;
    await ensureLinkCandidates();
  }

  async function openEdit(ev: AssociationCalendarEvent) {
    editingId = ev.id;
    formTitle = ev.title;
    formKind = ev.kind ?? 'event';
    formDescription = ev.description ?? '';
    formStart = toDatetimeLocalValue(ev.startsAt);
    formEnd = ev.endsAt ? toDatetimeLocalValue(ev.endsAt) : '';
    formLinkedFormId = ev.linkedFormId ?? '';
    formCoOwnerIds = (ev.coOwners ?? []).map((co) => co.associationId);
    formImageUrl = ev.imageUrl ?? null;
    formError = '';
    modalOpen = true;
    await ensureLinkCandidates();
  }

  async function handleImageUpload(e: Event) {
    if (!editingId) return;
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    uploadingImage = true;
    formError = '';
    try {
      const updated = await uploadCalendarEventImage(associationId, editingId, file);
      formImageUrl = updated.imageUrl ?? null;
      // Also refresh the list so the card shows the new image
      await loadMonth();
    } catch (err) {
      formError = err instanceof Error ? err.message : m.asso_calendar_image_upload_error();
    } finally {
      uploadingImage = false;
      input.value = '';
    }
  }

  async function handleImageRemove() {
    if (!editingId) return;
    uploadingImage = true;
    try {
      await deleteCalendarEventImage(associationId, editingId);
      formImageUrl = null;
      await loadMonth();
    } catch (err) {
      formError = err instanceof Error ? err.message : 'Erreur';
    } finally {
      uploadingImage = false;
    }
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

  async function submitForm() {
    if (!formTitle.trim() || !formStart) {
      formError = m.asso_calendar_error_title_required();
      return;
    }
    const startIso = new Date(formStart).toISOString();
    const endIso = formEnd.trim() ? new Date(formEnd).toISOString() : undefined;
    saving = true;
    formError = '';
    try {
      if (editingId) {
        await updateAssociationCalendarEvent(associationId, editingId, {
          title: formTitle.trim(),
          kind: formKind,
          description: formDescription.trim() || undefined,
          startsAt: startIso,
          endsAt: endIso,
          linkedFormId: formLinkedFormId.trim() || null,
          coOwnerIds: formCoOwnerIds,
        });
      } else {
        await createAssociationCalendarEvent(associationId, {
          title: formTitle.trim(),
          kind: formKind,
          description: formDescription.trim() || undefined,
          startsAt: startIso,
          endsAt: endIso,
          ...(formLinkedFormId.trim() ? { linkedFormId: formLinkedFormId.trim() } : {}),
          coOwnerIds: formCoOwnerIds,
        });
        dismissEventModal(false);
        await loadMonth();
        saving = false;
        return;
      }
      dismissEventModal(false);
      await loadMonth();
    } catch (e) {
      formError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      saving = false;
    }
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
      loadError = e instanceof Error ? e.message : 'Erreur';
    }
  }

  async function validateEvent(id: string) {
    try {
      await validateAssociationCalendarEvent(associationId, id);
      await loadMonth();
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Erreur';
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
          class="bg-cn-yellow text-cn-dark hover:bg-cn-yellow-hover inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold shadow-sm transition-colors"
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
      class="border-cn-border text-text-main hover:bg-cn-bg inline-flex items-center justify-center rounded-xl border p-2 transition-colors"
      aria-label={m.asso_calendar_prev_month_label()}
    >
      <ChevronLeft size={20} />
    </button>
    <p class="text-text-main flex-1 text-center text-base font-bold capitalize">{titleMonth}</p>
    <button
      type="button"
      onclick={nextMonth}
      class="border-cn-border text-text-main hover:bg-cn-bg inline-flex items-center justify-center rounded-xl border p-2 transition-colors"
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

  <MonthCalendarGridRich {focusDate} events={feedEvents} {loading} bind:selectedDay />

  <CalendarDayEventsPanel
    {focusDate}
    {selectedDay}
    events={feedEvents}
    hideAssociationName={true}
    onEventClick={openEventDetail}
    onClearSelection={() => (selectedDay = null)}
  />

  <CalendarEventDetailModal
    open={detailModalOpen}
    event={detailEvent}
    {canEdit}
    showAssociation={false}
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
                class="text-amber-warn bg-amber-warn/20 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase"
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
              class="border-cn-border hover:bg-cn-bg text-text-main rounded-xl border p-2"
              title={m.common_edit_label()}
            >
              <Pencil size={16} />
            </button>
            <button
              type="button"
              onclick={() => removeEvent(ev.id)}
              class="border-red-err/30 text-red-err hover:bg-red-err/10 rounded-xl border p-2"
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
                class="text-red-err bg-red-err/20 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase"
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
              class="border-red-err/30 text-red-err hover:bg-red-err/10 rounded-xl border p-2"
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

{#if modalOpen}
  <div use:portal>
    <div
      data-keyboard-aware-overlay
      class="z-[280] flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center"
      role="presentation"
      onclick={(e) => e.target === e.currentTarget && closeModal()}
    >
      <div
        class="keyboard-aware-modal-panel border-cn-border max-h-[90vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-3xl border bg-(--cn-surface) p-6 shadow-xl sm:rounded-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cal-modal-title"
      >
        <h3 id="cal-modal-title" class="text-text-main text-lg font-bold">
          {editingId ? m.asso_calendar_modal_edit_title() : m.asso_calendar_modal_create_title()}
        </h3>
        {#if !editingId}
          <p class="text-text-muted text-xs">
            {m.asso_calendar_modal_pending_note()}
          </p>
        {/if}
        <Input label={m.asso_calendar_event_title_label()} bind:value={formTitle} />

        <!-- Entry kind: normal event card vs full-day background band (break / vacation). -->
        <div>
          <span class="text-text-main mb-1 ml-1 block text-sm font-bold"
            >{m.asso_calendar_event_kind_label()}</span
          >
          <div class="grid grid-cols-2 gap-2">
            <button
              type="button"
              onclick={() => (formKind = 'event')}
              class="rounded-xl border px-3 py-2 text-sm font-semibold transition-colors {formKind ===
              'event'
                ? 'border-cn-yellow bg-cn-yellow/10 text-cn-dark'
                : 'border-cn-border text-text-muted hover:bg-cn-bg'}"
            >
              {m.asso_calendar_event_kind_event()}
            </button>
            <button
              type="button"
              onclick={() => (formKind = 'break')}
              class="rounded-xl border px-3 py-2 text-sm font-semibold transition-colors {formKind ===
              'break'
                ? 'border-cn-yellow bg-cn-yellow/10 text-cn-dark'
                : 'border-cn-border text-text-muted hover:bg-cn-bg'}"
            >
              {m.asso_calendar_event_kind_break()}
            </button>
          </div>
          {#if formKind === 'break'}
            <p class="text-text-muted mt-1 ml-1 text-xs">
              {m.asso_calendar_event_kind_break_hint()}
            </p>
          {/if}
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="text-text-main mb-1 ml-1 block text-sm font-bold" for="ev-start"
              >{m.asso_calendar_event_start_label()}</label
            >
            <input
              id="ev-start"
              type="datetime-local"
              bind:value={formStart}
              class="border-cn-border text-text-main w-full rounded-xl border bg-(--cn-surface) px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label class="text-text-main mb-1 ml-1 block text-sm font-bold" for="ev-end"
              >{m.asso_calendar_event_end_label()}</label
            >
            <input
              id="ev-end"
              type="datetime-local"
              bind:value={formEnd}
              class="border-cn-border text-text-main w-full rounded-xl border bg-(--cn-surface) px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div>
          <p class="text-text-main mb-1 ml-1 block text-sm font-bold">
            {m.asso_calendar_event_description_label()}
          </p>
          <MarkdownComposerField
            bind:value={formDescription}
            placeholder={m.calendar_deposit_placeholder()}
            minHeight="100px"
          />
        </div>
        <!-- Poster image - only available when editing an existing event -->
        {#if editingId}
          <div class="space-y-2">
            <p class="text-text-main ml-1 text-sm font-bold">
              {m.asso_calendar_event_poster_label()}
            </p>
            {#if formImageUrl}
              <div class="border-cn-border relative overflow-hidden rounded-xl border">
                <img
                  src={formImageUrl}
                  alt={m.asso_calendar_poster_alt()}
                  class="max-h-48 w-full object-cover"
                  loading="lazy"
                />
                <button
                  type="button"
                  onclick={handleImageRemove}
                  disabled={uploadingImage}
                  class="absolute top-2 right-2 rounded-full bg-black/60 p-1 text-white hover:bg-black/80"
                  title={m.asso_calendar_poster_remove_title()}
                >
                  <X size={14} />
                </button>
              </div>
            {:else}
              <label
                class="border-cn-border bg-cn-bg/40 text-text-muted hover:border-cn-yellow/50 flex cursor-pointer items-center gap-2 rounded-xl border-2 border-dashed px-4 py-3 text-sm transition-colors {uploadingImage
                  ? 'pointer-events-none opacity-50'
                  : ''}"
              >
                <ImagePlus size={18} class="text-text-muted/60 shrink-0" />
                {uploadingImage
                  ? m.asso_calendar_poster_uploading()
                  : m.asso_calendar_poster_add_label()}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  class="sr-only"
                  onchange={handleImageUpload}
                />
              </label>
            {/if}
          </div>
        {:else}
          <p class="text-text-muted text-xs">
            {m.asso_calendar_poster_after_save_note()}
          </p>
        {/if}
        <!-- Co-owner associations picker -->
        <CoOwnerPicker bind:selectedIds={formCoOwnerIds} excludeId={associationId} />
        {#if canEdit && linkCandidates}
          <div class="border-cn-border/70 bg-cn-bg/30 space-y-3 rounded-xl border p-3">
            <p
              class="text-text-muted flex items-center gap-1 text-xs font-bold tracking-wide uppercase"
            >
              <Link2 size={14} />
              {m.asso_calendar_link_form_label()}
            </p>
            <div>
              <label class="text-text-main mb-1 block text-xs font-semibold" for="cal-link-form"
                >{m.asso_calendar_form_label()}</label
              >
              <select
                id="cal-link-form"
                bind:value={formLinkedFormId}
                class="border-cn-border text-text-main w-full rounded-xl border bg-(--cn-surface) px-3 py-2 text-sm"
              >
                <option value="">{m.asso_calendar_link_form_none_option()}</option>
                {#each linkCandidates.forms as f (f.id)}
                  <option value={f.id}>{f.title}</option>
                {/each}
              </select>
            </div>
          </div>
        {/if}
        {#if formError}
          <p class="text-red-err text-sm">{formError}</p>
        {/if}
        <div class="flex flex-wrap justify-end gap-2 pt-2">
          <button
            type="button"
            onclick={closeModal}
            class="border-cn-border hover:bg-cn-bg rounded-xl border px-4 py-2 text-sm font-semibold"
          >
            {m.common_cancel_button()}
          </button>
          <button
            type="button"
            onclick={submitForm}
            disabled={saving}
            class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50"
          >
            {saving ? m.asso_calendar_saving_label() : m.common_save_button()}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<CalendarSubscribeModal
  open={showSubscribeModal}
  onClose={() => (showSubscribeModal = false)}
  icsUrl={calendarIcsUrl}
  intro={m.asso_calendar_subscribe_intro()}
/>
