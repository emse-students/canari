<script lang="ts">
  import { onMount } from 'svelte';
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    listAggregatedCalendarFeed,
    listAssociations,
    listPendingCalendarEvents,
    listMyAssociations,
    createAssociationCalendarEvent,
    hasPermissionFlag,
    AssociationPermissionFlag,
    type AssociationCalendarFeedEvent,
    type Association,
  } from '$lib/associations/api';
  import { isGlobalAdmin } from '$lib/stores/user';
  import Card from '$lib/components/ui/Card.svelte';
  import MonthCalendarGridRich from '$lib/components/calendar/MonthCalendarGridRich.svelte';
  import CalendarDayEventsPanel from '$lib/components/calendar/CalendarDayEventsPanel.svelte';
  import CalendarEventDetailModal from '$lib/components/calendar/CalendarEventDetailModal.svelte';
  import CoOwnerPicker from '$lib/components/calendar/CoOwnerPicker.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import MarkdownComposerField from '$lib/components/shared/MarkdownComposerField.svelte';
  import { portal } from '$lib/actions/portal';
  import {
    ChevronLeft,
    ChevronRight,
    CalendarDays,
    CalendarCheck,
    CalendarPlus,
    ShieldAlert,
    FileDown,
  } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

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
    } catch (e) {
      loadError = e instanceof Error ? e.message : m.common_generic_error_label();
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
      canDepositEvent = true;
    } else {
      try {
        const mine = await listMyAssociations();
        canModerateAgenda = mine.some((a) => a.isAdmin);
        // A BDE validator (VALIDATE_EVENTS in a BDE association) may deposit on behalf of
        // any association; we keep their BDE association as the authorisation :id.
        const authority = mine.find(
          (a) =>
            a.isBDE &&
            hasPermissionFlag(a.permissions ?? 0, AssociationPermissionFlag.VALIDATE_EVENTS)
        );
        depositAuthorityAssoId = authority?.id ?? '';
        canDepositEvent = !!authority;
      } catch {
        canModerateAgenda = false;
        canDepositEvent = false;
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

  // ── Event deposit (global admins + BDE validators) ────────────────────────
  // These users can auto-validate events. A global admin posts directly on the
  // chosen association; a BDE validator posts via their BDE association and
  // redirects with `targetAssocId`.

  /** Whether the current user may deposit an auto-validated event for any association. */
  let canDepositEvent = $state(false);
  /** BDE association id (with VALIDATE_EVENTS) used as the URL :id for non-global-admins. */
  let depositAuthorityAssoId = $state('');
  let depositModalOpen = $state(false);
  let depositTargetAssocId = $state('');
  let depositTitle = $state('');
  let depositDescription = $state('');
  let depositStart = $state('');
  let depositEnd = $state('');
  let depositCoOwnerIds = $state<string[]>([]);
  let depositSaving = $state(false);
  let depositError = $state('');

  function pad(n: number): string {
    return n < 10 ? `0${n}` : `${n}`;
  }

  /** datetime-local value for "now" rounded down to the hour (minutes forced to :00). */
  function nowHourLocal(): string {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
  }

  function openDeposit() {
    depositTargetAssocId = filterAssociationId || associations[0]?.id || '';
    depositTitle = '';
    depositDescription = '';
    depositStart = nowHourLocal();
    depositEnd = '';
    depositCoOwnerIds = [];
    depositError = '';
    depositModalOpen = true;
  }

  async function submitDeposit() {
    if (!depositTargetAssocId) {
      depositError = m.calendar_error_choose_asso();
      return;
    }
    if (!depositTitle.trim() || !depositStart) {
      depositError = m.calendar_error_title_required();
      return;
    }
    const startIso = new Date(depositStart).toISOString();
    const endIso = depositEnd.trim() ? new Date(depositEnd).toISOString() : undefined;
    depositSaving = true;
    depositError = '';
    try {
      // Admin global : poste directement sur l'asso cible (auto-valide cote serveur).
      // Validateur BDE : poste via son asso BDE avec targetAssocId vers l'asso cible.
      const urlAssocId = isGlobalAdmin() ? depositTargetAssocId : depositAuthorityAssoId;
      await createAssociationCalendarEvent(urlAssocId, {
        title: depositTitle.trim(),
        description: depositDescription.trim() || undefined,
        startsAt: startIso,
        endsAt: endIso,
        ...(isGlobalAdmin() ? {} : { targetAssocId: depositTargetAssocId }),
        coOwnerIds: depositCoOwnerIds,
      });
      depositModalOpen = false;
      await loadMonth();
    } catch (e) {
      depositError = e instanceof Error ? e.message : m.common_generic_error_label();
    } finally {
      depositSaving = false;
    }
  }

  const exportHref = $derived.by(() => {
    const monthKey = `${focusDate.getFullYear()}-${String(focusDate.getMonth() + 1).padStart(2, '0')}`;
    const parts = [`month=${encodeURIComponent(monthKey)}`];
    if (filterAssociationId) parts.push(`association=${encodeURIComponent(filterAssociationId)}`);
    return `/calendar/export?${parts.join('&')}`;
  });
</script>

<div class="px-4 py-6 sm:px-6 max-w-3xl mx-auto space-y-6">
  <a href="/associations" class="text-sm text-text-muted hover:text-text-main transition-colors">
    ← {m.calendar_back_associations()}
  </a>

  <div class="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <h1 class="text-2xl font-extrabold text-text-main tracking-tight flex items-center gap-2">
        <CalendarDays size={28} class="text-cn-dark shrink-0" />
        {m.calendar_heading()}
      </h1>
      <p class="text-sm text-text-muted mt-1">
        {m.calendar_subtitle()}
      </p>
    </div>
    {#if canDepositEvent}
      <button
        type="button"
        onclick={openDeposit}
        class="inline-flex items-center justify-center gap-2 shrink-0 rounded-xl bg-cn-yellow px-4 py-2.5 text-sm font-bold text-cn-dark shadow-sm hover:bg-cn-yellow-hover transition-colors"
      >
        <CalendarPlus size={18} />
        {m.calendar_deposit_button()}
      </button>
    {/if}
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
        {m.calendar_moderate_label()}
        {#if pendingCount > 0}
          <span class="rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-bold text-white">
            {pendingCount}
          </span>
        {/if}
      </span>
      <span class="text-xs text-amber-800/80 dark:text-amber-200/80">{m.calendar_moderate_open()} →</span>
    </a>
  {/if}

  <Card class="p-4 sm:p-5 space-y-4">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex items-center gap-2">
        <button
          type="button"
          onclick={prevMonth}
          class="rounded-xl border border-cn-border p-2 text-text-main hover:bg-[var(--cn-surface)] transition-colors"
          aria-label={m.calendar_prev_month()}
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
          aria-label={m.calendar_next_month()}
        >
          <ChevronRight size={20} />
        </button>
      </div>

      <label class="flex flex-col gap-1 text-xs font-semibold text-text-muted sm:min-w-[14rem]">
        {m.calendar_filter_label()}
        <select
          class="rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm font-medium text-text-main"
          bind:value={filterAssociationId}
          onchange={onFilterSelectChange}
        >
          <option value="">{m.calendar_filter_all()}</option>
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
      >
        <FileDown size={18} />
        {m.calendar_export_pdf()}
      </a>
      <a
        href={calendarSubscribeUrl()}
        class="hidden sm:inline-flex items-center justify-center gap-2 shrink-0 rounded-xl bg-cn-yellow px-4 py-2.5 text-sm font-bold text-cn-dark shadow-sm hover:bg-cn-yellow-hover transition-colors"
      >
        <CalendarCheck size={18} />
        {m.calendar_subscribe()}
      </a>
    </div>
  </Card>

  <MonthCalendarGridRich {focusDate} events={sortedEvents} {loading} bind:selectedDay />

  {#if loadError}
    <div class="rounded-xl bg-red-50 border border-red-200 text-red-700 p-4 text-sm">
      {loadError}
    </div>
  {:else if !loading && sortedEvents.length === 0}
    <Card class="p-8 text-center text-text-muted text-sm">{m.calendar_empty()}</Card>
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

{#if depositModalOpen}
  <div use:portal>
    <div
      data-keyboard-aware-overlay
      class="z-[280] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm"
      role="presentation"
      onclick={(e) => e.target === e.currentTarget && (depositModalOpen = false)}
    >
      <div
        class="keyboard-aware-modal-panel w-full max-w-lg rounded-t-3xl sm:rounded-2xl border border-cn-border bg-[var(--cn-surface)] shadow-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-labelledby="deposit-modal-title"
      >
        <h3 id="deposit-modal-title" class="text-lg font-bold text-text-main">
          {m.calendar_deposit_modal_title()}
        </h3>
        <p class="text-xs text-text-muted">
          L'evenement est publie immediatement au nom de l'association choisie.
        </p>

        <div>
          <label class="block text-sm font-bold text-text-main mb-1 ml-1" for="deposit-asso"
            >{m.calendar_deposit_on_behalf()}</label
          >
          <select
            id="deposit-asso"
            bind:value={depositTargetAssocId}
            class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm text-text-main"
          >
            {#each associations as a (a.id)}
              <option value={a.id}>{a.name}</option>
            {/each}
          </select>
        </div>

        <Input label={m.calendar_deposit_title_label()} bind:value={depositTitle} />

        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="block text-sm font-bold text-text-main mb-1 ml-1" for="deposit-start"
              >{m.calendar_deposit_start_label()}</label
            >
            <input
              id="deposit-start"
              type="datetime-local"
              bind:value={depositStart}
              class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm text-text-main"
            />
          </div>
          <div>
            <label class="block text-sm font-bold text-text-main mb-1 ml-1" for="deposit-end"
              >{m.calendar_deposit_end_label()}</label
            >
            <input
              id="deposit-end"
              type="datetime-local"
              bind:value={depositEnd}
              class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm text-text-main"
            />
          </div>
        </div>

        <div>
          <p class="block text-sm font-bold text-text-main mb-1 ml-1">{m.calendar_deposit_desc_label()}</p>
          <MarkdownComposerField
            bind:value={depositDescription}
            placeholder={m.calendar_deposit_placeholder()}
            minHeight="100px"
          />
        </div>

        <CoOwnerPicker bind:selectedIds={depositCoOwnerIds} excludeId={depositTargetAssocId} />

        {#if depositError}
          <p class="text-sm text-red-600">{depositError}</p>
        {/if}

        <div class="flex flex-wrap gap-2 justify-end pt-2">
          <button
            type="button"
            onclick={() => (depositModalOpen = false)}
            class="rounded-xl border border-cn-border px-4 py-2 text-sm font-semibold hover:bg-cn-bg"
          >
            {m.common_cancel_button()}
          </button>
          <button
            type="button"
            onclick={submitDeposit}
            disabled={depositSaving}
            class="rounded-xl bg-cn-yellow px-4 py-2 text-sm font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
          >
            {depositSaving ? m.calendar_deposit_publishing() : m.calendar_deposit_publish()}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}
