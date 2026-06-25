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
    type AssociationCalendarEvent,
    type AssociationCalendarFeedEvent,
    type AssociationLinkCandidates,
  } from '$lib/associations/api';
  import {
    buildIcsCalendar,
    downloadTextFile,
    type AgendaExportEvent,
  } from '$lib/calendar/agendaExport';
  import Modal from '$lib/components/shared/Modal.svelte';
  import MonthCalendarGridRich from '$lib/components/calendar/MonthCalendarGridRich.svelte';
  import CalendarDayEventsPanel from '$lib/components/calendar/CalendarDayEventsPanel.svelte';
  import CalendarEventDetailModal from '$lib/components/calendar/CalendarEventDetailModal.svelte';
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
    new Intl.DateTimeFormat(getLocale() === 'en' ? 'en-US' : 'fr-FR', { month: 'long', year: 'numeric' }).format(focusDate)
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
  let isCopied = $state(false);

  /** ~15 months window for feed subscription (server max ~18 months). */
  function icsSubscriptionRangeISO(): { from: string; to: string } {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth() - 3, 1, 0, 0, 0, 0);
    const to = new Date(now.getFullYear(), now.getMonth() + 12, 0, 23, 59, 59, 999);
    return { from: from.toISOString(), to: to.toISOString() };
  }

  const calendarIcsUrl = $derived.by(() => {
    if (!browser) return '';
    const { from, to } = icsSubscriptionRangeISO();
    return aggregatedCalendarFeedIcsAbsoluteUrl({ from, to, associationId });
  });

  const googleCalendarSubscribeUrl = $derived.by(() => {
    if (!calendarIcsUrl) return '';
    const httpUrl = calendarIcsUrl.replace(/^https:/, 'http:');
    return `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(httpUrl)}`;
  });

  const webcalUrl = $derived(calendarIcsUrl.replace(/^https?:/, 'webcal:'));

  function copyCalendarLink() {
    if (!calendarIcsUrl) return;
    void navigator.clipboard.writeText(calendarIcsUrl);
    isCopied = true;
    setTimeout(() => {
      isCopied = false;
    }, 2000);
  }

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
    if (!await showConfirm(m.asso_calendar_confirm_delete(), { danger: true, confirmLabel: m.common_delete_button() })) {
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
          description: formDescription.trim() || undefined,
          startsAt: startIso,
          endsAt: endIso,
          linkedFormId: formLinkedFormId.trim() || null,
          coOwnerIds: formCoOwnerIds,
        });
      } else {
        await createAssociationCalendarEvent(associationId, {
          title: formTitle.trim(),
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
    if (!await showConfirm(m.asso_calendar_confirm_delete(), { danger: true, confirmLabel: m.common_delete_button() })) return;
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
      <h2 class="text-lg font-bold text-text-main tracking-tight">{m.asso_tab_calendar()}</h2>
      <p class="text-sm text-text-muted">
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
        class="inline-flex items-center justify-center gap-2 rounded-xl border border-cn-border px-4 py-2.5 text-sm font-semibold text-text-main hover:bg-cn-bg transition-colors"
      >
        <CalendarSync size={18} />
        {m.asso_calendar_subscribe_button()}
      </button>
      <button
        type="button"
        onclick={exportMonthIcs}
        disabled={loading || validatedEvents.length === 0}
        class="inline-flex items-center justify-center gap-2 rounded-xl border border-cn-border px-4 py-2.5 text-sm font-semibold text-text-main hover:bg-cn-bg transition-colors disabled:opacity-40 disabled:pointer-events-none"
      >
        <Download size={18} />
        {m.asso_calendar_export_ics_button()}
      </button>
      {#if canEdit}
        <button
          type="button"
          onclick={openCreate}
          class="inline-flex items-center justify-center gap-2 rounded-xl bg-cn-yellow px-4 py-2.5 text-sm font-bold text-cn-dark shadow-sm hover:bg-cn-yellow-hover transition-colors"
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
      class="inline-flex items-center justify-center rounded-xl border border-cn-border p-2 text-text-main hover:bg-cn-bg transition-colors"
      aria-label={m.asso_calendar_prev_month_label()}
    >
      <ChevronLeft size={20} />
    </button>
    <p class="text-base font-bold text-text-main capitalize flex-1 text-center">{titleMonth}</p>
    <button
      type="button"
      onclick={nextMonth}
      class="inline-flex items-center justify-center rounded-xl border border-cn-border p-2 text-text-main hover:bg-cn-bg transition-colors"
      aria-label={m.asso_calendar_next_month_label()}
    >
      <ChevronRight size={20} />
    </button>
  </div>

  {#if loadError}
    <div class="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">
      {loadError}
    </div>
  {/if}

  <MonthCalendarGridRich
    {focusDate}
    events={feedEvents}
    {loading}
    bind:selectedDay
  />

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
    onClose={() => {
      detailModalOpen = false;
      detailEvent = null;
    }}
    onEdit={handleDetailEdit}
    onDelete={handleDetailDelete}
  />

  {#if canEdit && !loading && sortedPendingEvents.length > 0}
    <div class="space-y-3">
      <h3 class="text-sm font-bold text-amber-700 uppercase tracking-wide">
        {m.asso_calendar_pending_section_title({ count: sortedPendingEvents.length })}
      </h3>
      {#each sortedPendingEvents as ev (ev.id)}
        <div
          class="rounded-2xl border border-amber-200 bg-amber-50/60 px-4 py-3 flex flex-col sm:flex-row sm:items-start gap-3"
        >
          <div class="min-w-0 flex-1">
            <p class="font-bold text-text-main flex items-center gap-2 flex-wrap">
              {ev.title}
              <span
                class="text-[10px] font-bold uppercase tracking-wide text-amber-800 bg-amber-200/80 px-2 py-0.5 rounded-full"
              >
                {m.asso_calendar_pending_badge()}
              </span>
            </p>
            <p class="text-xs text-text-muted mt-0.5">{formatEventRange(ev)}</p>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onclick={() => validateEvent(ev.id)}
              class="inline-flex items-center gap-1 rounded-xl bg-cn-yellow px-3 py-2 text-xs font-bold text-cn-ink hover:bg-cn-yellow-hover"
              title={m.asso_calendar_validate_title()}
            >
              <Check size={14} />
              {m.common_validate_button()}
            </button>
            <button
              type="button"
              onclick={() => openEdit(ev)}
              class="rounded-xl border border-cn-border p-2 hover:bg-cn-bg text-text-main"
              title={m.common_edit_label()}
            >
              <Pencil size={16} />
            </button>
            <button
              type="button"
              onclick={() => removeEvent(ev.id)}
              class="rounded-xl border border-red-200 p-2 text-red-600 hover:bg-red-50"
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
      <h3 class="text-sm font-bold text-red-700 uppercase tracking-wide">
        {m.asso_calendar_rejected_section_title({ count: sortedRejectedEvents.length })}
      </h3>
      {#each sortedRejectedEvents as ev (ev.id)}
        <div
          class="rounded-2xl border border-red-200 bg-red-50/60 dark:bg-red-950/20 px-4 py-3 flex flex-col sm:flex-row sm:items-start gap-3"
        >
          <div class="min-w-0 flex-1">
            <p class="font-bold text-text-main flex items-center gap-2 flex-wrap">
              {ev.title}
              <span
                class="text-[10px] font-bold uppercase tracking-wide text-red-700 bg-red-200/80 px-2 py-0.5 rounded-full"
              >
                {m.asso_calendar_rejected_badge()}
              </span>
            </p>
            <p class="text-xs text-text-muted mt-0.5">{formatEventRange(ev)}</p>
            {#if ev.rejectionReason?.trim()}
              <p class="text-xs text-red-600 mt-1">{m.asso_calendar_rejection_reason_prefix()}{ev.rejectionReason}</p>
            {/if}
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onclick={() => removeEvent(ev.id)}
              class="rounded-xl border border-red-200 p-2 text-red-600 hover:bg-red-50"
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
      class="z-[280] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm"
      role="presentation"
      onclick={(e) => e.target === e.currentTarget && closeModal()}
    >
    <div
      class="keyboard-aware-modal-panel w-full max-w-lg rounded-t-3xl sm:rounded-2xl border border-cn-border bg-[var(--cn-surface)] shadow-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cal-modal-title"
    >
      <h3 id="cal-modal-title" class="text-lg font-bold text-text-main">
        {editingId ? m.asso_calendar_modal_edit_title() : m.asso_calendar_modal_create_title()}
      </h3>
      {#if !editingId}
        <p class="text-xs text-text-muted">
          {m.asso_calendar_modal_pending_note()}
        </p>
      {/if}
      <Input label={m.asso_calendar_event_title_label()} bind:value={formTitle} />
      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <label class="block text-sm font-bold text-text-main mb-1 ml-1" for="ev-start"
            >{m.asso_calendar_event_start_label()}</label
          >
          <input
            id="ev-start"
            type="datetime-local"
            bind:value={formStart}
            class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm text-text-main"
          />
        </div>
        <div>
          <label class="block text-sm font-bold text-text-main mb-1 ml-1" for="ev-end"
            >{m.asso_calendar_event_end_label()}</label
          >
          <input
            id="ev-end"
            type="datetime-local"
            bind:value={formEnd}
            class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm text-text-main"
          />
        </div>
      </div>
      <div>
        <p class="block text-sm font-bold text-text-main mb-1 ml-1">{m.asso_calendar_event_description_label()}</p>
        <MarkdownComposerField
          bind:value={formDescription}
          placeholder={m.calendar_deposit_placeholder()}
          minHeight="100px"
        />
      </div>
      <!-- Poster image - only available when editing an existing event -->
      {#if editingId}
        <div class="space-y-2">
          <p class="text-sm font-bold text-text-main ml-1">{m.asso_calendar_event_poster_label()}</p>
          {#if formImageUrl}
            <div class="relative rounded-xl overflow-hidden border border-cn-border">
              <img src={formImageUrl} alt={m.asso_calendar_poster_alt()} class="w-full max-h-48 object-cover" loading="lazy" />
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
              class="flex items-center gap-2 cursor-pointer rounded-xl border-2 border-dashed border-cn-border bg-cn-bg/40 px-4 py-3 text-sm text-text-muted hover:border-cn-yellow/50 transition-colors {uploadingImage
                ? 'opacity-50 pointer-events-none'
                : ''}"
            >
              <ImagePlus size={18} class="shrink-0 text-text-muted/60" />
              {uploadingImage ? m.asso_calendar_poster_uploading() : m.asso_calendar_poster_add_label()}
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
        <p class="text-xs text-text-muted">
          {m.asso_calendar_poster_after_save_note()}
        </p>
      {/if}
      <!-- Co-owner associations picker -->
      <CoOwnerPicker bind:selectedIds={formCoOwnerIds} excludeId={associationId} />
      {#if canEdit && linkCandidates}
        <div class="space-y-3 rounded-xl border border-cn-border/70 bg-cn-bg/30 p-3">
          <p
            class="text-xs font-bold text-text-muted uppercase tracking-wide flex items-center gap-1"
          >
            <Link2 size={14} />
            {m.asso_calendar_link_form_label()}
          </p>
          <div>
            <label class="block text-xs font-semibold text-text-main mb-1" for="cal-link-form"
              >{m.asso_calendar_form_label()}</label
            >
            <select
              id="cal-link-form"
              bind:value={formLinkedFormId}
              class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm text-text-main"
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
        <p class="text-sm text-red-600">{formError}</p>
      {/if}
      <div class="flex flex-wrap gap-2 justify-end pt-2">
        <button
          type="button"
          onclick={closeModal}
          class="rounded-xl border border-cn-border px-4 py-2 text-sm font-semibold hover:bg-cn-bg"
        >
          {m.common_cancel_button()}
        </button>
        <button
          type="button"
          onclick={submitForm}
          disabled={saving}
          class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
        >
          {saving ? m.asso_calendar_saving_label() : m.common_save_button()}
        </button>
      </div>
    </div>
    </div>
  </div>
{/if}

<Modal
  open={showSubscribeModal}
  title={m.asso_calendar_subscribe_modal_title()}
  maxWidth="max-w-lg"
  onClose={() => (showSubscribeModal = false)}
>
  <div class="space-y-6 text-sm text-text-main">
    <p class="text-text-muted">
      {m.asso_calendar_subscribe_intro()}
    </p>

    <div class="space-y-3">
      <h3 class="text-sm font-bold text-cn-dark">{m.asso_calendar_google_title()}</h3>
      {#if googleCalendarSubscribeUrl}
        <a
          href={googleCalendarSubscribeUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex w-full items-center justify-center rounded-xl bg-cn-yellow px-4 py-2.5 text-sm font-bold text-cn-dark shadow-sm hover:bg-cn-yellow-hover transition-colors"
        >
          {m.asso_calendar_google_add_button()}
        </a>
      {/if}

      <details class="group">
        <summary class="cursor-pointer text-text-muted hover:text-text-main">
          {m.asso_calendar_manual_add_summary()}
        </summary>
        <ol class="mt-3 ml-4 list-decimal space-y-1.5 text-text-muted leading-relaxed">
          <li>{m.asso_calendar_manual_step1()}</li>
          <li>
            {m.asso_calendar_manual_step2_open()}
            <a
              href="https://calendar.google.com"
              target="_blank"
              rel="noopener noreferrer"
              class="font-semibold text-cn-dark underline"
            >
              {m.asso_calendar_manual_step2_link()}
            </a>
          </li>
          <li>{m.asso_calendar_manual_step3()}</li>
          <li>{m.asso_calendar_manual_step4()}</li>
          <li>{m.asso_calendar_manual_step5()}</li>
        </ol>

        {#if calendarIcsUrl}
          <div class="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              readonly
              value={calendarIcsUrl}
              class="min-w-0 flex-1 rounded-xl border border-cn-border bg-cn-bg/50 px-3 py-2 text-xs font-mono text-text-main"
              onclick={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              onclick={copyCalendarLink}
              class="shrink-0 rounded-xl border border-cn-border px-4 py-2 text-sm font-semibold hover:bg-cn-bg transition-colors"
            >
              {isCopied ? m.asso_calendar_copied() : m.asso_calendar_copy_button()}
            </button>
          </div>
        {/if}
      </details>
    </div>

    <div class="space-y-3">
      <h3 class="text-sm font-bold text-cn-dark">{m.asso_calendar_apple_title()}</h3>
      <p class="text-text-muted">
        {m.asso_calendar_apple_intro()}
      </p>
      {#if webcalUrl}
        <a
          href={webcalUrl}
          class="inline-flex w-full items-center justify-center rounded-xl bg-cn-yellow px-4 py-2.5 text-sm font-bold text-cn-dark shadow-sm hover:bg-cn-yellow-hover transition-colors"
        >
          {m.asso_calendar_apple_subscribe_button()}
        </a>
      {/if}
    </div>

    <p class="text-[11px] text-text-muted">
      {m.asso_calendar_subscribe_note()}
    </p>
  </div>
</Modal>
