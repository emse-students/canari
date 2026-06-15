<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import AddEventToCalendarButton from '$lib/components/calendar/AddEventToCalendarButton.svelte';
  import { associationLogoSrc, type AssociationCalendarFeedEvent } from '$lib/associations/api';
  import type { AgendaExportEvent } from '$lib/calendar/agendaExport';
  import { CalendarDays, ClipboardList, Pencil, Trash2 } from '@lucide/svelte';

  interface Props {
    open: boolean;
    event: AssociationCalendarFeedEvent | null;
    canEdit?: boolean;
    onClose: () => void;
    onEdit?: (ev: AssociationCalendarFeedEvent) => void;
    onDelete?: (id: string) => void;
  }

  let { open, event, canEdit = false, onClose, onEdit, onDelete }: Props = $props();

  function formatEventRange(ev: AssociationCalendarFeedEvent): string {
    const s = new Date(ev.startsAt);
    const fmt = new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });
    if (!ev.endsAt) return fmt.format(s);
    const e = new Date(ev.endsAt);
    return `${fmt.format(s)} - ${new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(e)}`;
  }

  function toAgendaExport(ev: AssociationCalendarFeedEvent): AgendaExportEvent {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return {
      id: ev.id,
      title: `${ev.title} - ${ev.associationName}`,
      description: ev.description,
      startsAt: ev.startsAt,
      endsAt: ev.endsAt,
      sourceUrl: origin
        ? `${origin}/associations/${encodeURIComponent(ev.associationSlug)}`
        : undefined,
    };
  }
</script>

<Modal {open} title={event?.title ?? 'Événement'} maxWidth="max-w-lg" onClose={onClose}>
  {#if event}
    <div class="space-y-4 text-sm">
      {#if !canEdit}
        <p class="text-xs font-semibold uppercase tracking-wide text-cn-dark/80">
          <a
            href="/associations/{encodeURIComponent(event.associationSlug)}"
            class="hover:underline"
          >
            {event.associationName}
          </a>
          {#each event.coOwners ?? [] as co (co.associationId)}
            <span class="text-text-muted"> · </span>
            <a href="/associations/{encodeURIComponent(co.slug)}" class="hover:underline">
              {co.name}
            </a>
          {/each}
        </p>
      {/if}

      <p class="text-text-muted flex items-center gap-2">
        <CalendarDays size={16} class="shrink-0" />
        {formatEventRange(event)}
      </p>

      {#if associationLogoSrc(event.imageUrl)}
        <img
          src={associationLogoSrc(event.imageUrl) ?? ''}
          alt=""
          class="w-full rounded-xl object-cover max-h-52 border border-cn-border/40"
        />
      {/if}

      {#if event.description?.trim()}
        <div class="rounded-xl border border-cn-border/50 bg-cn-bg/30 p-3">
          <ProfileBioMarkdown source={event.description} />
        </div>
      {/if}

      {#if event.linkedFormId}
        <a
          href="/forms/{encodeURIComponent(event.linkedFormId)}"
          class="inline-flex items-center gap-2 rounded-xl border border-cn-border bg-cn-bg/50 px-3 py-2 text-xs font-semibold text-text-main hover:border-cn-yellow/50 transition-colors"
        >
          <ClipboardList size={14} />
          Formulaire lié
        </a>
      {/if}

      <div class="flex flex-wrap items-center gap-2 pt-2 border-t border-cn-border/60">
        <AddEventToCalendarButton event={toAgendaExport(event)} />
        {#if canEdit && onEdit}
          <button
            type="button"
            onclick={() => {
              onEdit(event);
              onClose();
            }}
            class="inline-flex items-center gap-1.5 rounded-xl border border-cn-border px-3 py-2 text-xs font-semibold text-text-main hover:bg-cn-bg transition-colors"
          >
            <Pencil size={14} />
            Modifier
          </button>
        {/if}
        {#if canEdit && onDelete}
          <button
            type="button"
            onclick={() => onDelete?.(event.id)}
            class="inline-flex items-center gap-1.5 rounded-xl border border-red-200 px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50 transition-colors"
          >
            <Trash2 size={14} />
            Supprimer
          </button>
        {/if}
      </div>
    </div>
  {/if}
</Modal>
