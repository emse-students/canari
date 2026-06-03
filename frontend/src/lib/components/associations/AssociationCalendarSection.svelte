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
    listAssociations,
    uploadCalendarEventImage,
    deleteCalendarEventImage,
    aggregatedCalendarFeedIcsAbsoluteUrl,
    type AssociationCalendarEvent,
    type AssociationLinkCandidates,
    type Association,
  } from '$lib/associations/api';
  import { generateAvatarColor } from '$lib/utils/avatar';
  import { toHex } from '$lib/utils/color';
  import {
    buildIcsCalendar,
    downloadTextFile,
    type AgendaExportEvent,
  } from '$lib/calendar/agendaExport';
  import Modal from '$lib/components/shared/Modal.svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { portal } from '$lib/actions/portal';
  import {
    ChevronLeft,
    ChevronRight,
    CalendarPlus,
    Pencil,
    Trash2,
    Clock,
    Link2,
    ClipboardList,
    CalendarSync,
    Download,
    Check,
    ImagePlus,
    X,
    Users,
  } from '@lucide/svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import { SvelteDate } from 'svelte/reactivity';
  import { pushHistoryOverlay, closeHistoryOverlayFromUi } from '$lib/utils/historyOverlayStack';

  interface Props {
    associationId: string;
    /** Used in exported / subscribed ICS (`URL` field). */
    associationSlug?: string;
    canEdit?: boolean;
    /** Hex color of this association for calendar cell gradient (e.g. "#e83e8c"). */
    associationColor?: string | null;
  }

  let {
    associationId,
    associationSlug,
    canEdit = false,
    associationColor = null,
  }: Props = $props();

  let events = $state<AssociationCalendarEvent[]>([]);
  let loading = $state(true);
  let loadError = $state('');
  let focusDate = $state(new Date());

  /** Visible month / year */
  const titleMonth = $derived(
    new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(focusDate)
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
    const m = pad(focusDate.getMonth() + 1);
    downloadTextFile(
      `agenda-${associationSlug ?? associationId}-${y}-${m}.ics`,
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
        includePending: canEdit,
      });
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      loading = false;
    }
  }

  onMount(loadMonth);

  function prevMonth() {
    focusDate = new Date(focusDate.getFullYear(), focusDate.getMonth() - 1, 1);
    loadMonth();
  }

  function nextMonth() {
    focusDate = new Date(focusDate.getFullYear(), focusDate.getMonth() + 1, 1);
    loadMonth();
  }

  const validatedEvents = $derived(events.filter((e) => (e.status ?? 'validated') === 'validated'));
  const pendingEvents = $derived(events.filter((e) => e.status === 'pending'));
  const rejectedEvents = $derived(events.filter((e) => e.status === 'rejected'));

  function eventCoversDay(ev: { startsAt: string; endsAt: string | null }, d: Date): boolean {
    const start = new Date(ev.startsAt);
    const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    if (!ev.endsAt) return d.getTime() === startDay.getTime();
    const end = new Date(ev.endsAt);
    const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    return d >= startDay && d <= endDay;
  }

  function hasValidatedEventOnDay(day: number): boolean {
    const d = new Date(focusDate.getFullYear(), focusDate.getMonth(), day);
    return validatedEvents.some((ev) => eventCoversDay(ev, d));
  }

  function hasPendingEventOnDay(day: number): boolean {
    if (!canEdit) return false;
    const d = new Date(focusDate.getFullYear(), focusDate.getMonth(), day);
    return pendingEvents.some((ev) => eventCoversDay(ev, d));
  }

  /** Monday-first calendar cells for the visible month */
  const calendarCells = $derived.by(() => {
    const y = focusDate.getFullYear();
    const m = focusDate.getMonth();
    const first = new Date(y, m, 1);
    const lastDay = new Date(y, m + 1, 0).getDate();
    const mondayIndex = (first.getDay() + 6) % 7; // 0 = Monday column
    const cells: { day: number | null; inMonth: boolean }[] = [];
    for (let i = 0; i < mondayIndex; i++) cells.push({ day: null, inMonth: false });
    for (let day = 1; day <= lastDay; day++) cells.push({ day, inMonth: true });
    while (cells.length % 7 !== 0 || cells.length < 42) {
      cells.push({ day: null, inMonth: false });
    }
    return cells;
  });

  const weekdayLabels = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

  const sortedValidatedEvents = $derived(
    [...validatedEvents].sort(
      (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
    )
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

  // ── Co-owner picker ───────────────────────────────────────────────────────

  /** IDs of co-owner associations selected for the current form. */
  let formCoOwnerIds = $state<string[]>([]);
  let allAssociations = $state<Association[]>([]);
  let coOwnerSearchQuery = $state('');
  let coOwnerDropdownOpen = $state(false);

  async function ensureAllAssociations() {
    if (allAssociations.length > 0) return;
    try {
      allAssociations = await listAssociations();
    } catch {
      allAssociations = [];
    }
  }

  const coOwnerCandidates = $derived(
    allAssociations.filter(
      (a) =>
        a.id !== associationId &&
        !formCoOwnerIds.includes(a.id) &&
        (coOwnerSearchQuery.trim() === '' ||
          a.name.toLowerCase().includes(coOwnerSearchQuery.toLowerCase()))
    )
  );

  const selectedCoOwners = $derived(allAssociations.filter((a) => formCoOwnerIds.includes(a.id)));

  function addCoOwner(id: string) {
    if (!formCoOwnerIds.includes(id)) formCoOwnerIds = [...formCoOwnerIds, id];
    coOwnerSearchQuery = '';
    coOwnerDropdownOpen = false;
  }

  function removeCoOwner(id: string) {
    formCoOwnerIds = formCoOwnerIds.filter((x) => x !== id);
  }

  // ── Calendar gradient helpers ─────────────────────────────────────────────

  function hexToRgba(hex: string, alpha: number): string {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  /** Inline style string for a calendar day cell (transparent gradient, or empty). */
  function dayCellStyle(day: number): string {
    const d = new Date(focusDate.getFullYear(), focusDate.getMonth(), day);
    const dayEvents = validatedEvents.filter((ev) => eventCoversDay(ev, d));
    if (dayEvents.length === 0) return '';

    const seenIds: string[] = [];
    const hexColors: string[] = [];

    for (const ev of dayEvents) {
      if (!seenIds.includes(ev.associationId)) {
        seenIds.push(ev.associationId);
        const raw =
          ev.associationId === associationId
            ? (associationColor ?? generateAvatarColor(associationId))
            : generateAvatarColor(ev.associationId);
        hexColors.push(toHex(raw));
      }
      for (const co of ev.coOwners ?? []) {
        if (!seenIds.includes(co.associationId)) {
          seenIds.push(co.associationId);
          hexColors.push(toHex(co.color ?? generateAvatarColor(co.associationId)));
        }
      }
    }

    if (hexColors.length === 1) {
      return `background-color:${hexToRgba(hexColors[0], 0.18)};`;
    }
    const step = 100 / hexColors.length;
    const stops = hexColors
      .map((c, i) => {
        const rgba = hexToRgba(c, 0.18);
        const from = Math.round(i * step);
        const to = Math.round((i + 1) * step);
        return i === 0 ? `${rgba} ${to}%` : `${rgba} ${from}% ${to}%`;
      })
      .join(', ');
    return `background:linear-gradient(to right,${stops});`;
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
    await Promise.all([ensureLinkCandidates(), ensureAllAssociations()]);
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
    await Promise.all([ensureLinkCandidates(), ensureAllAssociations()]);
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
      formError = err instanceof Error ? err.message : "Erreur lors de l'envoi de l'image";
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
      formError = 'Titre et date de début requis.';
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
    if (!await showConfirm('Supprimer cet événement ?', { danger: true, confirmLabel: 'Supprimer' })) return;
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
    const s = new Date(ev.startsAt);
    const fmt = new Intl.DateTimeFormat('fr-FR', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    if (!ev.endsAt) return fmt.format(s);
    const e = new Date(ev.endsAt);
    return `${fmt.format(s)} - ${new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(e)}`;
  }
</script>

<div class="space-y-5">
  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <div>
      <h2 class="text-lg font-bold text-text-main tracking-tight">Agenda</h2>
      <p class="text-sm text-text-muted">
        Calendrier mensuel et liste des événements validés.
        {#if canEdit}
          Les nouveaux événements sont en attente de validation avant publication.
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
        S'abonner au calendrier
      </button>
      <button
        type="button"
        onclick={exportMonthIcs}
        disabled={loading || validatedEvents.length === 0}
        class="inline-flex items-center justify-center gap-2 rounded-xl border border-cn-border px-4 py-2.5 text-sm font-semibold text-text-main hover:bg-cn-bg transition-colors disabled:opacity-40 disabled:pointer-events-none"
      >
        <Download size={18} />
        .ics (ce mois)
      </button>
      {#if canEdit}
        <button
          type="button"
          onclick={openCreate}
          class="inline-flex items-center justify-center gap-2 rounded-xl bg-cn-yellow px-4 py-2.5 text-sm font-bold text-cn-dark shadow-sm hover:bg-cn-yellow-hover transition-colors"
        >
          <CalendarPlus size={18} />
          Proposer un événement
        </button>
      {/if}
    </div>
  </div>

  <div class="flex items-center justify-between gap-2">
    <button
      type="button"
      onclick={prevMonth}
      class="inline-flex items-center justify-center rounded-xl border border-cn-border p-2 text-text-main hover:bg-cn-bg transition-colors"
      aria-label="Mois précédent"
    >
      <ChevronLeft size={20} />
    </button>
    <p class="text-base font-bold text-text-main capitalize flex-1 text-center">{titleMonth}</p>
    <button
      type="button"
      onclick={nextMonth}
      class="inline-flex items-center justify-center rounded-xl border border-cn-border p-2 text-text-main hover:bg-cn-bg transition-colors"
      aria-label="Mois suivant"
    >
      <ChevronRight size={20} />
    </button>
  </div>

  {#if loadError}
    <div class="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">
      {loadError}
    </div>
  {/if}

  <!-- Mini month grid (orientation) + list detail below - meilleur compromis mobile -->
  <div class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/90 p-4 shadow-sm">
    {#if loading}
      <div class="flex justify-center py-10">
        <div
          class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
        ></div>
      </div>
    {:else}
      <div
        class="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-2"
      >
        {#each weekdayLabels as w (w)}
          <span>{w}</span>
        {/each}
      </div>
      <div class="grid grid-cols-7 gap-1">
        {#each calendarCells as cell (cell)}
          {#if cell.day === null}
            <div class="aspect-square rounded-xl bg-transparent"></div>
          {:else}
            {@const gradStyle = dayCellStyle(cell.day)}
            <div
              class="aspect-square rounded-xl flex flex-col items-center justify-center text-sm relative border transition-colors
              {hasValidatedEventOnDay(cell.day)
                ? 'border-cn-yellow/50 font-semibold text-text-main'
                : hasPendingEventOnDay(cell.day)
                  ? 'border-amber-300/50 bg-amber-50/80 font-semibold text-text-main'
                  : 'border-cn-border/40 bg-cn-bg/30 text-text-muted'}"
              style={gradStyle || undefined}
            >
              <span>{cell.day}</span>
              {#if hasValidatedEventOnDay(cell.day)}
                <span class="absolute bottom-1 h-1 w-1 rounded-full bg-cn-yellow"></span>
              {:else if hasPendingEventOnDay(cell.day)}
                <span class="absolute bottom-1 h-1 w-1 rounded-full bg-amber-500"></span>
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>

  {#if canEdit && !loading && sortedPendingEvents.length > 0}
    <div class="space-y-3">
      <h3 class="text-sm font-bold text-amber-700 uppercase tracking-wide">
        En attente de validation ({sortedPendingEvents.length})
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
                En attente
              </span>
            </p>
            <p class="text-xs text-text-muted mt-0.5">{formatEventRange(ev)}</p>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onclick={() => validateEvent(ev.id)}
              class="inline-flex items-center gap-1 rounded-xl bg-cn-yellow px-3 py-2 text-xs font-bold text-cn-dark hover:bg-cn-yellow-hover"
              title="Valider et publier"
            >
              <Check size={14} />
              Valider
            </button>
            <button
              type="button"
              onclick={() => openEdit(ev)}
              class="rounded-xl border border-cn-border p-2 hover:bg-cn-bg text-text-main"
              title="Modifier"
            >
              <Pencil size={16} />
            </button>
            <button
              type="button"
              onclick={() => removeEvent(ev.id)}
              class="rounded-xl border border-red-200 p-2 text-red-600 hover:bg-red-50"
              title="Supprimer"
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
        Refusés par le BDE ({sortedRejectedEvents.length})
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
                Refusé
              </span>
            </p>
            <p class="text-xs text-text-muted mt-0.5">{formatEventRange(ev)}</p>
            {#if ev.rejectionReason?.trim()}
              <p class="text-xs text-red-600 mt-1">Motif : {ev.rejectionReason}</p>
            {/if}
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onclick={() => removeEvent(ev.id)}
              class="rounded-xl border border-red-200 p-2 text-red-600 hover:bg-red-50"
              title="Supprimer"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <div class="space-y-3">
    <h3 class="text-sm font-bold text-text-muted uppercase tracking-wide">Événements publiés</h3>
    {#if !loading && sortedValidatedEvents.length === 0}
      <p
        class="text-sm text-text-muted rounded-2xl border border-dashed border-cn-border px-4 py-8 text-center"
      >
        Aucun événement ce mois-ci.
        {#if canEdit}
          <button
            type="button"
            onclick={openCreate}
            class="text-cn-dark font-semibold underline ml-1"
          >
            En ajouter un
          </button>
        {/if}
      </p>
    {:else}
      {#each sortedValidatedEvents as ev (ev.id)}
        <div
          class="rounded-2xl border border-cn-border bg-[var(--cn-surface)]/95 px-4 py-3 flex flex-col sm:flex-row sm:items-start gap-3 shadow-sm"
        >
          <div
            class="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl bg-cn-yellow/20 text-cn-dark font-bold text-xs leading-tight"
          >
            <Clock size={14} class="mb-0.5 opacity-70" />
            {new Date(ev.startsAt).getDate()}
          </div>
          <div class="min-w-0 flex-1">
            {#if ev.imageUrl}
              <img
                src={ev.imageUrl}
                alt=""
                class="w-full rounded-xl object-cover max-h-40 mb-2 border border-cn-border/40"
              />
            {/if}
            <p class="font-bold text-text-main">{ev.title}</p>
            <p class="text-xs text-text-muted mt-0.5 flex items-center gap-1">
              {formatEventRange(ev)}
            </p>
            {#if ev.description?.trim()}
              <div class="mt-2">
                <ProfileBioMarkdown source={ev.description} />
              </div>
            {/if}
            {#if ev.linkedFormId}
              <div class="mt-3">
                <a
                  href="/forms/{encodeURIComponent(ev.linkedFormId)}"
                  class="inline-flex items-center gap-1 rounded-lg border border-cn-border bg-cn-bg/50 px-2 py-1 text-xs font-medium text-text-main hover:border-cn-yellow/50"
                >
                  <ClipboardList size={13} />
                  Formulaire lié
                </a>
              </div>
            {/if}
          </div>
          {#if canEdit}
            <div class="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onclick={() => openEdit(ev)}
                class="rounded-xl border border-cn-border p-2 hover:bg-cn-bg text-text-main"
                title="Modifier"
              >
                <Pencil size={16} />
              </button>
              <button
                type="button"
                onclick={() => removeEvent(ev.id)}
                class="rounded-xl border border-red-200 p-2 text-red-600 hover:bg-red-50"
                title="Supprimer"
              >
                <Trash2 size={16} />
              </button>
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
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
        {editingId ? 'Modifier l’événement' : 'Proposer un événement'}
      </h3>
      {#if !editingId}
        <p class="text-xs text-text-muted">
          L’événement sera visible par tous après validation par un administrateur.
        </p>
      {/if}
      <Input label="Titre" bind:value={formTitle} />
      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <label class="block text-sm font-bold text-text-main mb-1 ml-1" for="ev-start"
            >Début</label
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
            >Fin (optionnel)</label
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
        <p class="block text-sm font-bold text-text-main mb-1 ml-1">Description (optionnel)</p>
        <MarkdownComposerField
          bind:value={formDescription}
          placeholder="Décrivez l'événement…"
          minHeight="100px"
        />
      </div>
      <!-- Poster image - only available when editing an existing event -->
      {#if editingId}
        <div class="space-y-2">
          <p class="text-sm font-bold text-text-main ml-1">Affiche / image (optionnel)</p>
          {#if formImageUrl}
            <div class="relative rounded-xl overflow-hidden border border-cn-border">
              <img src={formImageUrl} alt="Affiche" class="w-full max-h-48 object-cover" loading="lazy" />
              <button
                type="button"
                onclick={handleImageRemove}
                disabled={uploadingImage}
                class="absolute top-2 right-2 rounded-full bg-black/60 p-1 text-white hover:bg-black/80"
                title="Supprimer l'affiche"
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
              {uploadingImage ? 'Envoi…' : 'Ajouter une affiche (JPEG / PNG / WebP)'}
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
          Vous pourrez ajouter une affiche après avoir créé l'événement.
        </p>
      {/if}
      <!-- Co-owner associations picker -->
      <div class="space-y-2 rounded-xl border border-cn-border/70 bg-cn-bg/30 p-3">
        <p
          class="text-xs font-bold text-text-muted uppercase tracking-wide flex items-center gap-1"
        >
          <Users size={14} />
          Associations partenaires (optionnel)
        </p>
        {#if selectedCoOwners.length > 0}
          <div class="flex flex-wrap gap-1.5">
            {#each selectedCoOwners as asso (asso.id)}
              <span
                class="inline-flex items-center gap-1 rounded-full border border-cn-border bg-[var(--cn-surface)] px-2.5 py-1 text-xs font-semibold text-text-main"
              >
                {#if asso.color}
                  <span
                    class="inline-block w-2 h-2 rounded-full shrink-0"
                    style="background:{asso.color}"
                  ></span>
                {/if}
                {asso.name}
                <button
                  type="button"
                  onclick={() => removeCoOwner(asso.id)}
                  class="ml-0.5 text-text-muted hover:text-red-500 transition-colors"
                  aria-label="Retirer {asso.name}"
                >
                  <X size={12} />
                </button>
              </span>
            {/each}
          </div>
        {/if}
        <div class="relative">
          <input
            type="text"
            placeholder="Rechercher une association…"
            bind:value={coOwnerSearchQuery}
            onfocus={() => (coOwnerDropdownOpen = true)}
            onblur={() => setTimeout(() => (coOwnerDropdownOpen = false), 150)}
            class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm text-text-main placeholder:text-text-muted"
          />
          {#if coOwnerDropdownOpen && coOwnerCandidates.length > 0}
            <ul
              class="absolute z-20 mt-1 w-full rounded-xl border border-cn-border bg-white/95 dark:bg-black/90 backdrop-blur-xl shadow-lg max-h-48 overflow-y-auto"
            >
              {#each coOwnerCandidates.slice(0, 12) as asso (asso.id)}
                <li>
                  <button
                    type="button"
                    onmousedown={(e) => {
                      e.preventDefault();
                      addCoOwner(asso.id);
                    }}
                    class="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-main hover:bg-cn-yellow/10 transition-colors text-left"
                  >
                    {#if asso.color}
                      <span
                        class="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                        style="background:{asso.color}"
                      ></span>
                    {/if}
                    {asso.name}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </div>
      {#if canEdit && linkCandidates}
        <div class="space-y-3 rounded-xl border border-cn-border/70 bg-cn-bg/30 p-3">
          <p
            class="text-xs font-bold text-text-muted uppercase tracking-wide flex items-center gap-1"
          >
            <Link2 size={14} />
            Lier un formulaire (optionnel)
          </p>
          <div>
            <label class="block text-xs font-semibold text-text-main mb-1" for="cal-link-form"
              >Formulaire</label
            >
            <select
              id="cal-link-form"
              bind:value={formLinkedFormId}
              class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm text-text-main"
            >
              <option value="">- Aucun -</option>
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
          Annuler
        </button>
        <button
          type="button"
          onclick={submitForm}
          disabled={saving}
          class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-dark hover:bg-cn-yellow-hover disabled:opacity-50"
        >
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      </div>
    </div>
    </div>
  </div>
{/if}

<Modal
  open={showSubscribeModal}
  title="Ajouter au calendrier"
  maxWidth="max-w-lg"
  onClose={() => (showSubscribeModal = false)}
>
  <div class="space-y-6 text-sm text-text-main">
    <p class="text-text-muted">
      Pour ajouter les événements de cette association à votre calendrier personnel :
    </p>

    <div class="space-y-3">
      <h3 class="text-sm font-bold text-cn-dark">Google Agenda / Android</h3>
      {#if googleCalendarSubscribeUrl}
        <a
          href={googleCalendarSubscribeUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex w-full items-center justify-center rounded-xl bg-cn-yellow px-4 py-2.5 text-sm font-bold text-cn-dark shadow-sm hover:bg-cn-yellow-hover transition-colors"
        >
          Ajouter à Google Agenda
        </a>
      {/if}

      <details class="group">
        <summary class="cursor-pointer text-text-muted hover:text-text-main">
          Ou ajouter manuellement
        </summary>
        <ol class="mt-3 ml-4 list-decimal space-y-1.5 text-text-muted leading-relaxed">
          <li>Copiez le lien ci-dessous</li>
          <li>
            Ouvrez
            <a
              href="https://calendar.google.com"
              target="_blank"
              rel="noopener noreferrer"
              class="font-semibold text-cn-dark underline"
            >
              Google Agenda
            </a>
          </li>
          <li>
            Dans le menu de gauche, cliquez sur le <strong>+</strong> à côté de « Autres agendas »
          </li>
          <li>Sélectionnez <strong>À partir de l'URL</strong></li>
          <li>Collez le lien et validez</li>
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
              {isCopied ? 'Copié !' : 'Copier'}
            </button>
          </div>
        {/if}
      </details>
    </div>

    <div class="space-y-3">
      <h3 class="text-sm font-bold text-cn-dark">iOS (Apple Calendar) / Autres</h3>
      <p class="text-text-muted">
        Cliquez sur le bouton ci-dessous pour vous abonner automatiquement :
      </p>
      {#if webcalUrl}
        <a
          href={webcalUrl}
          class="inline-flex w-full items-center justify-center rounded-xl bg-cn-yellow px-4 py-2.5 text-sm font-bold text-cn-dark shadow-sm hover:bg-cn-yellow-hover transition-colors"
        >
          S'abonner automatiquement
        </a>
      {/if}
    </div>

    <p class="text-[11px] text-text-muted">
      L'abonnement couvre environ 3 mois passés et 12 mois à venir. Le fichier est régénéré côté
      serveur à chaque synchronisation.
    </p>
  </div>
</Modal>
