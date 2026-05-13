<script lang="ts">
  import { onMount } from 'svelte';
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    listAggregatedCalendarFeed,
    listAssociations,
    aggregatedCalendarFeedIcsAbsoluteUrl,
    type AssociationCalendarFeedEvent,
    type Association,
  } from '$lib/associations/api';
  import { browser } from '$app/environment';
  import Card from '$lib/components/ui/Card.svelte';
  import {
    ChevronLeft,
    ChevronRight,
    CalendarDays,
    Download,
    ExternalLink,
    ClipboardList,
    Newspaper,
    Copy,
    Link2,
  } from 'lucide-svelte';
  import {
    buildIcsCalendar,
    downloadTextFile,
    googleCalendarTemplateUrl,
    type AgendaExportEvent,
  } from '$lib/calendar/agendaExport';

  let focusDate = $state(new Date());
  let associations = $state<Association[]>([]);
  let filterAssociationId = $state('');
  let events = $state<AssociationCalendarFeedEvent[]>([]);
  let loading = $state(true);
  let loadError = $state('');

  const titleMonth = $derived(
    new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(focusDate)
  );

  function pad(n: number) {
    return n < 10 ? `0${n}` : `${n}`;
  }

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
      events = await listAggregatedCalendarFeed({
        from,
        to,
        associationId: filterAssociationId || undefined,
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
    applyFilterToUrl();
    void loadMonth();
  }

  function prevMonth() {
    focusDate = new Date(focusDate.getFullYear(), focusDate.getMonth() - 1, 1);
    void loadMonth();
  }

  function nextMonth() {
    focusDate = new Date(focusDate.getFullYear(), focusDate.getMonth() + 1, 1);
    void loadMonth();
  }

  onMount(async () => {
    filterAssociationId = page.url.searchParams.get('association')?.trim() ?? '';
    await loadAssociations();
    await loadMonth();
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

  function eventSourceUrl(ev: AssociationCalendarFeedEvent): string {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}/associations/${encodeURIComponent(ev.associationSlug)}`;
  }

  function toAgendaExport(ev: AssociationCalendarFeedEvent): AgendaExportEvent {
    return {
      id: ev.id,
      title: `${ev.title} — ${ev.associationName}`,
      description: ev.description,
      startsAt: ev.startsAt,
      endsAt: ev.endsAt,
      sourceUrl: eventSourceUrl(ev),
    };
  }

  function exportMonthIcs() {
    if (events.length === 0) return;
    const body = buildIcsCalendar(events.map(toAgendaExport));
    const y = focusDate.getFullYear();
    const m = pad(focusDate.getMonth() + 1);
    const tag = filterAssociationId ? '-asso' : '';
    downloadTextFile(`canari-agenda-${y}-${m}${tag}.ics`, body, 'text/calendar;charset=utf-8');
  }

  function exportOneIcs(ev: AssociationCalendarFeedEvent) {
    downloadTextFile(
      `canari-event-${ev.id}.ics`,
      buildIcsCalendar([toAgendaExport(ev)]),
      'text/calendar;charset=utf-8'
    );
  }

  function formatEventRange(ev: AssociationCalendarFeedEvent): string {
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
    return `${fmt.format(s)} — ${new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(e)}`;
  }

  const sortedEvents = $derived(
    [...events].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
  );

  const dynamicIcsFeedUrl = $derived.by(() => {
    if (!browser) return '';
    const { from, to } = monthRangeISO(focusDate);
    return aggregatedCalendarFeedIcsAbsoluteUrl({
      from,
      to,
      associationId: filterAssociationId || undefined,
    });
  });

  let copyIcsHint = $state('');

  async function copyDynamicIcsUrl() {
    if (!dynamicIcsFeedUrl) return;
    try {
      await navigator.clipboard.writeText(dynamicIcsFeedUrl);
      copyIcsHint = 'Copié.';
      setTimeout(() => (copyIcsHint = ''), 2000);
    } catch {
      copyIcsHint = 'Copie impossible (navigateur).';
      setTimeout(() => (copyIcsHint = ''), 3000);
    }
  }
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
        Vue mensuelle, filtre par association, export <span class="font-medium">.ics</span> (iPhone,
        Android, Outlook…) et ouverture dans Google&nbsp;Agenda.
      </p>
    </div>
  </div>

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

    <div class="flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between border-t border-cn-border/60 pt-4">
      <p class="text-xs text-text-muted max-w-xl">
        Téléchargez le fichier <strong class="text-text-main">.ics</strong> puis ouvrez-le sur
        téléphone : iOS et Android proposent d’ajouter les événements au calendrier système. Vous
        pouvez aussi importer le fichier dans Google&nbsp;Agenda (Paramètres → Importer).
      </p>
      <button
        type="button"
        onclick={exportMonthIcs}
        disabled={loading || events.length === 0}
        class="inline-flex items-center justify-center gap-2 shrink-0 rounded-xl bg-cn-yellow px-4 py-2.5 text-sm font-bold text-cn-dark shadow-sm hover:bg-cn-yellow-hover transition-colors disabled:opacity-40 disabled:pointer-events-none"
      >
        <Download size={18} />
        .ics (ce mois)
      </button>
    </div>

    <div class="space-y-2 border-t border-cn-border/60 pt-4">
      <div class="flex items-center gap-2 text-sm font-bold text-text-main">
        <Link2 size={16} class="text-cn-dark shrink-0" />
        URL dynamique <span class="font-mono text-xs font-normal">.ics</span>
      </div>
      <p class="text-xs text-text-muted">
        Le fichier est généré côté serveur à chaque ouverture (même mois et même filtre association
        que ci-dessus). Copiez l’URL dans Google&nbsp;Agenda / Apple&nbsp;Calendrier (abonnement ou
        import), ou ouvrez-la dans un nouvel onglet.
      </p>
      {#if dynamicIcsFeedUrl}
        <div class="flex flex-col sm:flex-row gap-2 sm:items-stretch">
          <input
            type="text"
            readonly
            class="flex-1 min-w-0 rounded-xl border border-cn-border bg-black/5 dark:bg-white/5 px-3 py-2 text-xs font-mono text-text-main"
            value={dynamicIcsFeedUrl}
          />
          <div class="flex gap-2 shrink-0">
            <button
              type="button"
              onclick={copyDynamicIcsUrl}
              class="inline-flex flex-1 sm:flex-none items-center justify-center gap-1.5 rounded-xl border border-cn-border px-3 py-2 text-xs font-bold text-text-main hover:bg-[var(--cn-surface)] transition-colors"
            >
              <Copy size={16} />
              Copier
            </button>
            <a
              href={dynamicIcsFeedUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex flex-1 sm:flex-none items-center justify-center gap-1.5 rounded-xl border border-cn-border px-3 py-2 text-xs font-bold text-text-main hover:bg-[var(--cn-surface)] transition-colors"
            >
              <ExternalLink size={16} />
              Ouvrir
            </a>
          </div>
        </div>
        {#if copyIcsHint}
          <p class="text-xs text-cn-dark font-medium">{copyIcsHint}</p>
        {/if}
        <p class="text-[11px] text-text-muted">
          Sur certaines apps, remplacez <span class="font-mono">https://</span> par
          <span class="font-mono">webcal://</span> pour un abonnement automatique.
        </p>
      {/if}
    </div>
  </Card>

  {#if loadError}
    <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">{loadError}</div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-16">
      <div
        class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
      ></div>
    </div>
  {:else if sortedEvents.length === 0}
    <Card class="p-8 text-center text-text-muted text-sm">Aucun événement ce mois-ci.</Card>
  {:else}
    <ul class="space-y-3">
      {#each sortedEvents as ev (ev.id)}
        <li>
          <Card class="p-4 sm:p-5">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0 flex-1 space-y-1">
                <p class="text-xs font-semibold uppercase tracking-wide text-cn-dark/80">
                  <a
                    href="/associations/{encodeURIComponent(ev.associationSlug)}"
                    class="hover:underline"
                  >
                    {ev.associationName}
                  </a>
                </p>
                <h2 class="text-lg font-bold text-text-main leading-tight">{ev.title}</h2>
                <p class="text-sm text-text-muted flex items-center gap-1.5">
                  <CalendarDays size={14} class="shrink-0" />
                  {formatEventRange(ev)}
                </p>
                {#if ev.description?.trim()}
                  <p class="text-sm text-text-main/90 whitespace-pre-wrap">{ev.description}</p>
                {/if}
                <div class="flex flex-wrap gap-2 pt-1">
                  {#if ev.linkedPostId}
                    <a
                      href="/posts"
                      class="inline-flex items-center gap-1 rounded-lg bg-cn-yellow/15 px-2 py-1 text-xs font-semibold text-cn-dark hover:bg-cn-yellow/25"
                    >
                      <Newspaper size={12} />
                      Publication
                    </a>
                  {/if}
                  {#if ev.linkedFormId}
                    <a
                      href="/forms/{encodeURIComponent(ev.linkedFormId)}"
                      class="inline-flex items-center gap-1 rounded-lg bg-cn-yellow/15 px-2 py-1 text-xs font-semibold text-cn-dark hover:bg-cn-yellow/25"
                    >
                      <ClipboardList size={12} />
                      Formulaire
                    </a>
                  {/if}
                </div>
              </div>
              <div class="flex flex-wrap gap-2 shrink-0">
                <button
                  type="button"
                  onclick={() => exportOneIcs(ev)}
                  class="inline-flex items-center justify-center gap-1.5 rounded-xl border border-cn-border px-3 py-2 text-xs font-bold text-text-main hover:bg-[var(--cn-surface)] transition-colors"
                  title="Télécharger un fichier .ics pour ce créneau"
                >
                  <Download size={14} />
                  .ics
                </button>
                <a
                  href={googleCalendarTemplateUrl(toAgendaExport(ev))}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center justify-center gap-1.5 rounded-xl border border-cn-border px-3 py-2 text-xs font-bold text-text-main hover:bg-[var(--cn-surface)] transition-colors"
                >
                  <ExternalLink size={14} />
                  Google
                </a>
              </div>
            </div>
          </Card>
        </li>
      {/each}
    </ul>
  {/if}
</div>
