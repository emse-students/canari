<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listPendingCalendarEvents,
    validateAssociationCalendarEvent,
    rejectAssociationCalendarEvent,
    deleteAssociationCalendarEvent,
    associationLogoSrc,
    type AssociationCalendarFeedEvent,
  } from '$lib/associations/api';
  import { Check, X, Trash2, ExternalLink } from '@lucide/svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import CalendarEventDetailModal from '$lib/components/calendar/CalendarEventDetailModal.svelte';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { generateAvatarColor } from '$lib/utils/avatar';
  import { contrastColor, toHex } from '$lib/utils/color';
  import { m } from '$lib/paraglide/messages';
  import { getLocale } from '$lib/paraglide/runtime';

  let events = $state<AssociationCalendarFeedEvent[]>([]);
  let canValidate = $state(false);
  let loading = $state(true);
  let error = $state('');
  let actingId = $state<string | null>(null);

  /** Event currently being rejected - drives the reject modal. */
  let rejectTarget = $state<AssociationCalendarFeedEvent | null>(null);
  let rejectReason = $state('');
  let rejecting = $state(false);

  /** Event currently previewed in the shared detail modal (read-only). */
  let previewEvent = $state<AssociationCalendarFeedEvent | null>(null);

  /** Resolved hex color of the event's primary association (for the date badge). */
  function eventColor(ev: AssociationCalendarFeedEvent): string {
    return toHex(ev.associationColor ?? generateAvatarColor(ev.associationId));
  }

  async function load() {
    loading = true;
    error = '';
    try {
      const res = await listPendingCalendarEvents();
      events = res.events;
      canValidate = res.canValidate;
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_generic_error_label();
      events = [];
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function formatRange(ev: AssociationCalendarFeedEvent): string {
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

  async function validate(ev: AssociationCalendarFeedEvent) {
    actingId = ev.id;
    try {
      await validateAssociationCalendarEvent(ev.associationId, ev.id);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_generic_error_label();
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
      await rejectAssociationCalendarEvent(
        rejectTarget.associationId,
        rejectTarget.id,
        rejectReason
      );
      rejectTarget = null;
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_generic_error_label();
    } finally {
      rejecting = false;
    }
  }

  async function remove(ev: AssociationCalendarFeedEvent) {
    if (!await showConfirm(m.admin_agenda_delete_confirm_message({ title: ev.title }), { danger: true, confirmLabel: m.common_delete_button() })) return;
    actingId = ev.id;
    try {
      await deleteAssociationCalendarEvent(ev.associationId, ev.id);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : m.common_generic_error_label();
    } finally {
      actingId = null;
    }
  }
</script>

<div class="space-y-4">
  <div>
    <h2 class="text-lg font-bold text-text-main">{m.admin_agenda_title()}</h2>
    <p class="text-sm text-text-muted mt-1">
      {m.admin_agenda_subtitle()}
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
      {m.admin_agenda_empty()}
    </div>
  {:else}
    <ul class="space-y-3">
      {#each events as ev (ev.id)}
        {@const color = eventColor(ev)}
        {@const fg = contrastColor(color)}
        {@const logoSrc = associationLogoSrc(ev.associationLogoUrl)}
        <li
          class="rounded-2xl border border-cn-border bg-[var(--cn-surface)] px-4 py-4 flex flex-col sm:flex-row sm:items-start gap-4"
          style="border-left:4px solid {color};"
        >
          <div
            class="relative flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl font-bold text-sm overflow-hidden"
            style="background:{color};color:{fg};"
          >
            {#if logoSrc}
              <img
                src={logoSrc}
                alt=""
                aria-hidden="true"
                class="absolute inset-0 h-full w-full object-cover opacity-25"
              />
            {/if}
            <span class="relative z-10 leading-none">{new Date(ev.startsAt).getDate()}</span>
          </div>
          <div class="min-w-0 flex-1 space-y-1">
            <p class="text-xs font-semibold uppercase tracking-wide text-cn-dark/80">
              <a
                href="/associations/{encodeURIComponent(ev.associationSlug)}"
                class="hover:underline"
              >
                {ev.associationName}
              </a>
              {#each ev.coOwners ?? [] as co (co.associationId)}
                <span class="text-text-muted"> · </span>
                <a href="/associations/{encodeURIComponent(co.slug)}" class="hover:underline">
                  {co.name}
                </a>
              {/each}
            </p>
            <button
              type="button"
              onclick={() => (previewEvent = ev)}
              class="block text-left font-bold text-text-main hover:text-cn-yellow transition-colors"
            >
              {ev.title}
            </button>
            <p class="text-xs text-text-muted">{formatRange(ev)}</p>
            {#if ev.description?.trim()}
              <p class="text-sm text-text-muted whitespace-pre-wrap line-clamp-2">{ev.description}</p>
            {/if}
          </div>
          <div class="flex flex-wrap gap-2 shrink-0">
            {#if canValidate}
              <button
                type="button"
                onclick={() => validate(ev)}
                disabled={actingId === ev.id}
                class="inline-flex items-center gap-1.5 rounded-xl bg-cn-yellow px-3 py-2 text-xs font-bold text-cn-ink hover:bg-cn-yellow-hover disabled:opacity-50"
              >
                <Check size={14} />
                {m.admin_agenda_validate_button()}
              </button>
              <button
                type="button"
                onclick={() => openRejectModal(ev)}
                disabled={actingId === ev.id}
                class="inline-flex items-center gap-1.5 rounded-xl border border-orange-300 px-3 py-2 text-xs font-semibold text-orange-700 hover:bg-orange-50 disabled:opacity-50"
              >
                <X size={14} />
                {m.admin_agenda_reject_button()}
              </button>
            {/if}
            <a
              href="/associations/{encodeURIComponent(ev.associationSlug)}"
              class="inline-flex items-center gap-1 rounded-xl border border-cn-border px-3 py-2 text-xs font-semibold hover:bg-cn-bg"
            >
              <ExternalLink size={14} />
              {m.admin_agenda_association_link_label()}
            </a>
            <button
              type="button"
              onclick={() => remove(ev)}
              disabled={actingId === ev.id}
              class="inline-flex items-center gap-1 rounded-xl border border-red-200 px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              <Trash2 size={14} />
              {m.common_delete_button()}
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<!-- Read-only preview, reuses the same modal as the public agenda -->
<CalendarEventDetailModal
  open={previewEvent !== null}
  event={previewEvent}
  onClose={() => (previewEvent = null)}
/>

<!-- Reject modal -->
{#if rejectTarget}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
  >
    <div class="w-full max-w-md rounded-2xl bg-white dark:bg-cn-surface shadow-xl p-6 space-y-4">
      <h3 class="text-base font-bold text-text-main">{m.admin_agenda_reject_modal_title({ title: rejectTarget.title })}</h3>
      <p class="text-sm text-text-muted">
        {m.admin_agenda_reject_modal_desc()}
      </p>
      <div class="space-y-1.5">
        <span class="text-xs font-semibold text-text-muted uppercase tracking-wide"
          >{m.admin_agenda_reject_reason_label()}</span
        >
        <Textarea
          bind:value={rejectReason}
          rows={3}
          maxlength={1000}
          placeholder={m.admin_agenda_reject_reason_placeholder()}
        />
      </div>
      <div class="flex gap-2 justify-end">
        <button
          type="button"
          onclick={() => {
            rejectTarget = null;
          }}
          class="rounded-xl border border-cn-border px-4 py-2 text-sm font-semibold hover:bg-cn-bg"
        >
          {m.common_cancel_button()}
        </button>
        <button
          type="button"
          onclick={confirmReject}
          disabled={rejecting}
          class="inline-flex items-center gap-1.5 rounded-xl border border-orange-300 px-4 py-2 text-sm font-bold text-orange-700 hover:bg-orange-50 disabled:opacity-50"
        >
          <X size={14} />
          {rejecting ? m.admin_agenda_reject_confirm_progress() : m.admin_agenda_reject_confirm_button()}
        </button>
      </div>
    </div>
  </div>
{/if}
