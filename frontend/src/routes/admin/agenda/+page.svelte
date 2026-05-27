<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listPendingCalendarEvents,
    validateAssociationCalendarEvent,
    rejectAssociationCalendarEvent,
    deleteAssociationCalendarEvent,
    type AssociationCalendarFeedEvent,
  } from '$lib/associations/api';
  import { Check, X, Trash2, ExternalLink, Clock } from '@lucide/svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';

  let events = $state<AssociationCalendarFeedEvent[]>([]);
  let canValidate = $state(false);
  let loading = $state(true);
  let error = $state('');
  let actingId = $state<string | null>(null);

  /** Event currently being rejected — drives the reject modal. */
  let rejectTarget = $state<AssociationCalendarFeedEvent | null>(null);
  let rejectReason = $state('');
  let rejecting = $state(false);

  async function load() {
    loading = true;
    error = '';
    try {
      const res = await listPendingCalendarEvents();
      events = res.events;
      canValidate = res.canValidate;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Erreur';
      events = [];
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function formatRange(ev: AssociationCalendarFeedEvent): string {
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

  async function validate(ev: AssociationCalendarFeedEvent) {
    actingId = ev.id;
    try {
      await validateAssociationCalendarEvent(ev.associationId, ev.id);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Erreur';
    } finally {
      actingId = null;
    }
  }

  function openRejectModal(ev: AssociationCalendarFeedEvent) {
    rejectTarget = ev;
    rejectReason = '';
  }

  async function confirmReject() {
    if (!rejectTarget) return;
    rejecting = true;
    try {
      await rejectAssociationCalendarEvent(rejectTarget.associationId, rejectTarget.id, rejectReason);
      rejectTarget = null;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Erreur';
    } finally {
      rejecting = false;
    }
  }

  async function remove(ev: AssociationCalendarFeedEvent) {
    if (!confirm(`Supprimer « ${ev.title} » ?`)) return;
    actingId = ev.id;
    try {
      await deleteAssociationCalendarEvent(ev.associationId, ev.id);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Erreur';
    } finally {
      actingId = null;
    }
  }
</script>

<div class="space-y-4">
  <div>
    <h2 class="text-lg font-bold text-text-main">Événements en attente</h2>
    <p class="text-sm text-text-muted mt-1">
      Validez un événement pour le rendre visible sur l'agenda public et dans l'agenda global.
    </p>
  </div>

  {#if error}
    <div class="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">
      {error}
    </div>
  {/if}

  {#if loading}
    <div class="flex justify-center py-16">
      <div
        class="h-8 w-8 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
      ></div>
    </div>
  {:else if events.length === 0}
    <div
      class="rounded-2xl border border-dashed border-cn-border px-6 py-12 text-center text-sm text-text-muted"
    >
      Aucun événement en attente de validation.
    </div>
  {:else}
    <ul class="space-y-3">
      {#each events as ev (ev.id)}
        <li
          class="rounded-2xl border border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 px-4 py-4 flex flex-col sm:flex-row sm:items-start gap-4"
        >
          <div
            class="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl bg-amber-200/60 text-amber-900 font-bold text-xs"
          >
            <Clock size={14} class="mb-0.5 opacity-70" />
            {new Date(ev.startsAt).getDate()}
          </div>
          <div class="min-w-0 flex-1 space-y-1">
            <p class="text-xs font-semibold uppercase tracking-wide text-cn-dark/80">
              <a
                href="/associations/{encodeURIComponent(ev.associationSlug)}"
                class="hover:underline"
              >
                {ev.associationName}
              </a>
            </p>
            <p class="font-bold text-text-main">{ev.title}</p>
            <p class="text-xs text-text-muted">{formatRange(ev)}</p>
            {#if ev.description?.trim()}
              <p class="text-sm text-text-muted whitespace-pre-wrap">{ev.description}</p>
            {/if}
          </div>
          <div class="flex flex-wrap gap-2 shrink-0">
            {#if canValidate}
              <button
                type="button"
                onclick={() => validate(ev)}
                disabled={actingId === ev.id}
                class="inline-flex items-center gap-1.5 rounded-xl bg-cn-yellow px-3 py-2 text-xs font-bold text-cn-dark hover:bg-cn-yellow-hover disabled:opacity-50"
              >
                <Check size={14} />
                Valider
              </button>
              <button
                type="button"
                onclick={() => openRejectModal(ev)}
                disabled={actingId === ev.id}
                class="inline-flex items-center gap-1.5 rounded-xl border border-orange-300 px-3 py-2 text-xs font-semibold text-orange-700 hover:bg-orange-50 disabled:opacity-50"
              >
                <X size={14} />
                Refuser
              </button>
            {/if}
            <a
              href="/associations/{encodeURIComponent(ev.associationSlug)}"
              class="inline-flex items-center gap-1 rounded-xl border border-cn-border px-3 py-2 text-xs font-semibold hover:bg-cn-bg"
            >
              <ExternalLink size={14} />
              Association
            </a>
            <button
              type="button"
              onclick={() => remove(ev)}
              disabled={actingId === ev.id}
              class="inline-flex items-center gap-1 rounded-xl border border-red-200 px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              <Trash2 size={14} />
              Supprimer
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<!-- Reject modal -->
{#if rejectTarget}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
  >
    <div class="w-full max-w-md rounded-2xl bg-white dark:bg-cn-surface shadow-xl p-6 space-y-4">
      <h3 class="text-base font-bold text-text-main">Refuser « {rejectTarget.title} »</h3>
      <p class="text-sm text-text-muted">
        L'événement sera marqué comme refusé. L'association recevra une notification et pourra voir
        le motif dans sa page.
      </p>
      <div class="space-y-1.5">
        <span class="text-xs font-semibold text-text-muted uppercase tracking-wide">Motif (optionnel)</span>
        <Textarea
          bind:value={rejectReason}
          rows={3}
          maxlength={1000}
          placeholder="Ex : dates non conformes au règlement, contenu incomplet…"
        />
      </div>
      <div class="flex gap-2 justify-end">
        <button
          type="button"
          onclick={() => { rejectTarget = null; }}
          class="rounded-xl border border-cn-border px-4 py-2 text-sm font-semibold hover:bg-cn-bg"
        >
          Annuler
        </button>
        <button
          type="button"
          onclick={confirmReject}
          disabled={rejecting}
          class="inline-flex items-center gap-1.5 rounded-xl border border-orange-300 px-4 py-2 text-sm font-bold text-orange-700 hover:bg-orange-50 disabled:opacity-50"
        >
          <X size={14} />
          {rejecting ? 'En cours…' : 'Confirmer le refus'}
        </button>
      </div>
    </div>
  </div>
{/if}
