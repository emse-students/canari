<script lang="ts">
  import { onMount } from 'svelte';
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    listAggregatedCalendarFeed,
    listAssociations,
    listPendingCalendarEvents,
    listMyAssociations,
    type AssociationCalendarFeedEvent,
    type Association,
  } from '$lib/associations/api';
  import { isGlobalAdmin } from '$lib/stores/user';
  import Card from '$lib/components/ui/Card.svelte';
  import MonthCalendarGridRich from '$lib/components/calendar/MonthCalendarGridRich.svelte';
  import CalendarDayEventsPanel from '$lib/components/calendar/CalendarDayEventsPanel.svelte';
  import CalendarEventDetailModal from '$lib/components/calendar/CalendarEventDetailModal.svelte';
  import {
    ChevronLeft,
    ChevronRight,
    CalendarDays,
    CalendarCheck,
    ShieldAlert,
    FileDown,
  } from '@lucide/svelte';

  let focusDate = $state(new Date());
  let associations = $state<Association[]>([]);
  let filterAssociationId = $state('');
  let events = $state<AssociationCalendarFeedEvent[]>([]);
  let loading = $state(true);
  let loadError = $state('');

  const titleMonth = $derived(
    new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(focusDate)
  );

  function monthRangeISO(d: Date): { from: string; to: string } {
    const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
    return { from: start.toISOString(), to: end.toISOString() };
  }

  async function loadAssociations() {
    try {
      const list = await listAssociations();
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
      // includePending : le backend ne renvoie les événements en attente qu'aux
      // proposeurs / admins BDE / admins globaux (sinon ignoré). On le demande donc
      // systématiquement et c'est le serveur qui filtre.
      events = await listAggregatedCalendarFeed({
        from,
        to,
        associationId: filterAssociationId || undefined,
        includePending: true,
      });
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Erreur';
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

  onMount(async () => {
    filterAssociationId = page.url.searchParams.get('association')?.trim() ?? '';
    await loadAssociations();
    await loadMonth();
    if (isGlobalAdmin()) {
      canModerateAgenda = true;
    } else {
      try {
        const mine = await listMyAssociations();
        canModerateAgenda = mine.some((a) => a.isAdmin);
      } catch {
        canModerateAgenda = false;
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

  /** webcal:// URL for calendar app subscription (desktop only). */
  function calendarSubscribeUrl(): string {
    if (typeof window === 'undefined') return '';
    const query = filterAssociationId
      ? `?associationId=${encodeURIComponent(filterAssociationId)}`
      : '';
    return `webcal://${window.location.host}/api/associations/calendar/feed.ics${query}`;
  }

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

  const exportHref = $derived.by(() => {
    const m = `${focusDate.getFullYear()}-${String(focusDate.getMonth() + 1).padStart(2, '0')}`;
    const parts = [`month=${encodeURIComponent(m)}`];
    if (filterAssociationId) parts.push(`association=${encodeURIComponent(filterAssociationId)}`);
    return `/calendar/export?${parts.join('&')}`;
  });
</script>

<div class="px-4 py-6 sm:px-6 max-w-3xl mx-auto space-y-6">
  <a href="/associations" class="text-sm text-text-muted hover:text-text-main transition-colors">
    ← Associations
  </a>

  <div class="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <h1 class="text-2xl font-extrabold text-text-main tracking-tight flex items-center gap-2">
        <CalendarDays size={28} class="text-cn-dark shrink-0" />
        Agenda des associations
      </h1>
      <p class="text-sm text-text-muted mt-1">
        Calendrier mensuel — cliquez sur un jour pour voir les événements.
      </p>
    </div>
  </div>

  {#if canModerateAgenda}
    <a
      href="/admin/agenda"
      class="flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50/70 dark:bg-amber-950/30 px-4 py-3 hover:border-amber-300 transition-colors"
    >
      <span
        class="flex items-center gap-2 text-sm font-semibold text-amber-900 dark:text-amber-100"
      >
        <ShieldAlert size={18} />
        Modérer les événements en attente
        {#if pendingCount > 0}
          <span class="rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-white">
            {pendingCount}
          </span>
        {/if}
      </span>
      <span class="text-xs text-amber-800/80 dark:text-amber-200/80">Ouvrir la file →</span>
    </a>
  {/if}

  <Card class="p-4 sm:p-5 space-y-4">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex items-center gap-2">
        <button
          type="button"
          onclick={prevMonth}
          class="rounded-xl border border-cn-border p-2 text-text-main hover:bg-[var(--cn-surface)] transition-colors"
          aria-label="Mois précédent"
        >
          <ChevronLeft size={20} />
        </button>
        <span class="min-w-[10rem] text-center text-sm font-bold text-text-main capitalize">
          {titleMonth}
        </span>
        <button
          type="button"
          onclick={nextMonth}
          class="rounded-xl border border-cn-border p-2 text-text-main hover:bg-[var(--cn-surface)] transition-colors"
          aria-label="Mois suivant"
        >
          <ChevronRight size={20} />
        </button>
      </div>

      <label class="flex flex-col gap-1 text-xs font-semibold text-text-muted sm:min-w-[14rem]">
        Association
        <select
          class="rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm font-medium text-text-main"
          bind:value={filterAssociationId}
          onchange={onFilterSelectChange}
        >
          <option value="">Toutes les associations</option>
          {#each associations as a (a.id)}
            <option value={a.id}>{a.name}</option>
          {/each}
        </select>
      </label>
    </div>

    <div class="flex flex-wrap justify-end gap-2 border-t border-cn-border/60 pt-4">
      <a
        href={exportHref}
        class="inline-flex items-center justify-center gap-2 shrink-0 rounded-xl border border-cn-border bg-[var(--cn-surface)] px-4 py-2.5 text-sm font-bold text-text-main hover:bg-cn-bg transition-colors"
        title="Personnaliser et exporter le calendrier en PDF"
      >
        <FileDown size={18} />
        Exporter en PDF
      </a>
      <a
        href={calendarSubscribeUrl()}
        class="hidden sm:inline-flex items-center justify-center gap-2 shrink-0 rounded-xl bg-cn-yellow px-4 py-2.5 text-sm font-bold text-cn-dark shadow-sm hover:bg-cn-yellow-hover transition-colors"
        title="Abonner votre appli calendrier à ce feed (Apple Calendar, Google Calendar, Outlook…)"
      >
        <CalendarCheck size={18} />
        S'abonner au calendrier
      </a>
    </div>
  </Card>

  <MonthCalendarGridRich {focusDate} events={sortedEvents} {loading} bind:selectedDay />

  {#if loadError}
    <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">
      {loadError}
    </div>
  {:else if !loading && sortedEvents.length === 0}
    <Card class="p-8 text-center text-text-muted text-sm">Aucun événement ce mois-ci.</Card>
  {:else}
    <CalendarDayEventsPanel
      {focusDate}
      {selectedDay}
      events={sortedEvents}
      onEventClick={openEventDetail}
      onClearSelection={() => (selectedDay = null)}
    />
  {/if}

  <CalendarEventDetailModal
    open={detailModalOpen}
    event={detailEvent}
    onClose={() => {
      detailModalOpen = false;
      detailEvent = null;
    }}
  />
</div>
