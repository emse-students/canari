<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listAssociationCalendarEvents,
    createAssociationCalendarEvent,
    updateAssociationCalendarEvent,
    deleteAssociationCalendarEvent,
    listAssociationLinkCandidates,
    type AssociationCalendarEvent,
    type AssociationLinkCandidates,
  } from '$lib/associations/api';
  import {
    ChevronLeft,
    ChevronRight,
    CalendarPlus,
    Pencil,
    Trash2,
    Clock,
    Link2,
    Newspaper,
    ClipboardList,
  } from 'lucide-svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import { SvelteDate } from 'svelte/reactivity';

  interface Props {
    associationId: string;
    canEdit?: boolean;
  }

  let { associationId, canEdit = false }: Props = $props();

  let events = $state<AssociationCalendarEvent[]>([]);
  let loading = $state(true);
  let loadError = $state('');
  let focusDate = $state(new Date());

  /** Visible month / year */
  const titleMonth = $derived(
    new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(focusDate)
  );

  let modalOpen = $state(false);
  let editingId = $state<string | null>(null);
  let formTitle = $state('');
  let formDescription = $state('');
  /** datetime-local strings */
  let formStart = $state('');
  let formEnd = $state('');
  let saving = $state(false);
  let formError = $state('');
  let linkCandidates = $state<AssociationLinkCandidates | null>(null);
  /** Selected post/form IDs for modal (empty = none). */
  let formLinkedPostId = $state('');
  let formLinkedFormId = $state('');

  async function ensureLinkCandidates() {
    if (!canEdit) return;
    try {
      linkCandidates = await listAssociationLinkCandidates(associationId);
    } catch {
      linkCandidates = { posts: [], forms: [] };
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
      events = await listAssociationCalendarEvents(associationId, { from, to });
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

  function sameDay(a: Date, b: Date): boolean {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  function hasEventOnDay(day: number): boolean {
    const d = new Date(focusDate.getFullYear(), focusDate.getMonth(), day);
    return events.some((ev) => sameDay(new Date(ev.startsAt), d));
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

  const sortedEvents = $derived(
    [...events].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
  );

  async function openCreate() {
    editingId = null;
    formTitle = '';
    formDescription = '';
    formLinkedPostId = '';
    formLinkedFormId = '';
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
    formLinkedPostId = ev.linkedPostId ?? '';
    formLinkedFormId = ev.linkedFormId ?? '';
    formError = '';
    modalOpen = true;
    await ensureLinkCandidates();
  }

  function closeModal() {
    modalOpen = false;
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
          linkedPostId: formLinkedPostId.trim() || null,
          linkedFormId: formLinkedFormId.trim() || null,
        });
      } else {
        await createAssociationCalendarEvent(associationId, {
          title: formTitle.trim(),
          description: formDescription.trim() || undefined,
          startsAt: startIso,
          endsAt: endIso,
          ...(formLinkedPostId.trim() ? { linkedPostId: formLinkedPostId.trim() } : {}),
          ...(formLinkedFormId.trim() ? { linkedFormId: formLinkedFormId.trim() } : {}),
        });
      }
      modalOpen = false;
      await loadMonth();
    } catch (e) {
      formError = e instanceof Error ? e.message : 'Erreur';
    } finally {
      saving = false;
    }
  }

  async function removeEvent(id: string) {
    if (!confirm('Supprimer cet événement ?')) return;
    try {
      await deleteAssociationCalendarEvent(associationId, id);
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
    return `${fmt.format(s)} — ${new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(e)}`;
  }
</script>

<div class="space-y-5">
  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <div>
      <h2 class="text-lg font-bold text-text-main tracking-tight">Agenda</h2>
      <p class="text-sm text-text-muted">
        Calendrier mensuel (repères visuels) et liste des événements — réunions, permanences,
        échéances.
      </p>
    </div>
    {#if canEdit}
      <button
        type="button"
        onclick={openCreate}
        class="inline-flex items-center justify-center gap-2 rounded-xl bg-cn-yellow px-4 py-2.5 text-sm font-bold text-cn-dark shadow-sm hover:bg-cn-yellow-hover transition-colors"
      >
        <CalendarPlus size={18} />
        Nouvel événement
      </button>
    {/if}
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

  <!-- Mini month grid (orientation) + list detail below — meilleur compromis mobile -->
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
            <div
              class="aspect-square rounded-xl flex flex-col items-center justify-center text-sm relative border transition-colors
              {hasEventOnDay(cell.day)
                ? 'border-cn-yellow/50 bg-cn-yellow/10 font-semibold text-text-main'
                : 'border-cn-border/40 bg-cn-bg/30 text-text-muted'}"
            >
              <span>{cell.day}</span>
              {#if hasEventOnDay(cell.day)}
                <span class="absolute bottom-1 h-1 w-1 rounded-full bg-cn-yellow"></span>
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>

  <div class="space-y-3">
    <h3 class="text-sm font-bold text-text-muted uppercase tracking-wide">Événements du mois</h3>
    {#if !loading && sortedEvents.length === 0}
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
      {#each sortedEvents as ev (ev.id)}
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
            <p class="font-bold text-text-main">{ev.title}</p>
            <p class="text-xs text-text-muted mt-0.5 flex items-center gap-1">
              {formatEventRange(ev)}
            </p>
            {#if ev.description?.trim()}
              <p class="text-sm text-text-muted mt-2 whitespace-pre-wrap">{ev.description}</p>
            {/if}
            {#if ev.linkedPostId || ev.linkedFormId}
              <div class="mt-3 flex flex-wrap items-center gap-2">
                <span
                  class="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-text-muted"
                >
                  <Link2 size={12} />
                  Liens
                </span>
                {#if ev.linkedPostId}
                  <a
                    href="/posts"
                    class="inline-flex items-center gap-1 rounded-lg border border-cn-border bg-cn-bg/50 px-2 py-1 text-xs font-medium text-text-main hover:border-cn-yellow/50"
                  >
                    <Newspaper size={13} />
                    Publication
                  </a>
                {/if}
                {#if ev.linkedFormId}
                  <a
                    href="/forms/{encodeURIComponent(ev.linkedFormId)}"
                    class="inline-flex items-center gap-1 rounded-lg border border-cn-border bg-cn-bg/50 px-2 py-1 text-xs font-medium text-text-main hover:border-cn-yellow/50"
                  >
                    <ClipboardList size={13} />
                    Formulaire
                  </a>
                {/if}
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
  <div
    class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-4"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && closeModal()}
  >
    <div
      class="w-full max-w-lg rounded-2xl border border-cn-border bg-[var(--cn-surface)] shadow-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cal-modal-title"
    >
      <h3 id="cal-modal-title" class="text-lg font-bold text-text-main">
        {editingId ? 'Modifier l’événement' : 'Nouvel événement'}
      </h3>
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
      <Textarea label="Description (optionnel)" bind:value={formDescription} rows={4} />
      {#if canEdit && linkCandidates}
        <div class="space-y-3 rounded-xl border border-cn-border/70 bg-cn-bg/30 p-3">
          <p
            class="text-xs font-bold text-text-muted uppercase tracking-wide flex items-center gap-1"
          >
            <Link2 size={14} />
            Lier du contenu (même association)
          </p>
          <div>
            <label class="block text-xs font-semibold text-text-main mb-1" for="cal-link-post"
              >Publication sur le fil</label
            >
            <select
              id="cal-link-post"
              bind:value={formLinkedPostId}
              class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm text-text-main"
            >
              <option value="">— Aucune —</option>
              {#each linkCandidates.posts as p (p.id)}
                <option value={p.id}>
                  {p.preview.length > 90 ? `${p.preview.slice(0, 90)}…` : p.preview || p.id}
                </option>
              {/each}
            </select>
          </div>
          <div>
            <label class="block text-xs font-semibold text-text-main mb-1" for="cal-link-form"
              >Formulaire</label
            >
            <select
              id="cal-link-form"
              bind:value={formLinkedFormId}
              class="w-full rounded-xl border border-cn-border bg-[var(--cn-surface)] px-3 py-2 text-sm text-text-main"
            >
              <option value="">— Aucun —</option>
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
{/if}
