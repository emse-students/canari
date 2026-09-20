<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import LetterboxedImage from '$lib/components/shared/LetterboxedImage.svelte';
  import ProfileBioMarkdown from '$lib/components/profile/ProfileBioMarkdown.svelte';
  import AddEventToCalendarButton from '$lib/components/calendar/AddEventToCalendarButton.svelte';
  import {
    associationLogoSrc,
    getPostLinkedToCalendarEvent,
    type AssociationCalendarFeedEvent,
    type LinkedPostSummary,
  } from '$lib/associations/api';
  import type { AgendaExportEvent } from '$lib/calendar/agendaExport';
  import { eventOwners, type EventOwnerIdentity } from '$lib/calendar/feedEvents';
  import { CalendarDays, ClipboardList, Newspaper, Pencil, Trash2 } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  interface Props {
    open: boolean;
    event: AssociationCalendarFeedEvent | null;
    canEdit?: boolean;
    /**
     * Whether to name the owning association. False on that association's own page, where the
     * name is redundant; co-owners are listed either way, since they are never redundant.
     */
    showAssociation?: boolean;
    onClose: () => void;
    onEdit?: (ev: AssociationCalendarFeedEvent) => void;
    onDelete?: (id: string) => void;
  }

  let {
    open,
    event,
    canEdit = false,
    showAssociation = true,
    onClose,
    onEdit,
    onDelete,
  }: Props = $props();

  /**
   * Owning association (unless suppressed) then co-owners, in display order - the same list the
   * grid paints its bands from, so the two cannot disagree about who an event belongs to.
   */
  const identityLinks = $derived.by(() => {
    if (!event) return [] as EventOwnerIdentity[];
    const all = eventOwners(event);
    return showAssociation ? all : all.slice(1);
  });

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

  /**
   * The reverse of `event.linkedFormId`: a post names its event, never the other way round, so
   * this is fetched rather than read off the event itself. Keyed on the event's own id so
   * switching between two open events (the grid's own re-render, not a remount) still refetches.
   */
  let linkedPost = $state<LinkedPostSummary | null>(null);
  $effect(() => {
    const eventId = open ? event?.id : undefined;
    if (!eventId) {
      linkedPost = null;
      return;
    }
    getPostLinkedToCalendarEvent(eventId)
      .then((res) => {
        linkedPost = res.linkedPost;
      })
      .catch((err) => {
        linkedPost = null;
        Log.d('calendarEventDetailModal.linkedPost failed', err);
      });
  });

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

<Modal
  {open}
  title={event?.title ?? m.calendar_event_fallback_title()}
  maxWidth="max-w-lg"
  {onClose}
>
  {#if event}
    <div class="space-y-4 text-sm">
      <!--
        A PROPOSED EVENT SAYS SO HERE FIRST, BECAUSE THIS IS WHERE A READER DECIDES WHETHER TO COME.
        The month grid has always dimmed and dashed one; this modal is what the grid OPENS, and it
        said nothing at all until 2026-09-17 - so an event nobody has validated read exactly like a
        confirmed one at the moment it mattered most. The dashes are the same vocabulary the two row
        views use, and unlike them this surface has room to say it in a sentence rather than a
        tooltip.
      -->
      {#if event.status === 'pending'}
        <p
          class="border-cn-border text-text-muted rounded-xl border border-dashed px-3 py-2 text-xs"
        >
          {m.calendar_event_pending_notice()}
        </p>
      {/if}

      {#if identityLinks.length > 0}
        <p class="text-cn-dark/80 text-xs font-semibold tracking-wide uppercase">
          {#each identityLinks as link, i (link.associationId)}
            {#if i > 0}<span class="text-text-muted"> · </span>{/if}
            <a href="/associations/{encodeURIComponent(link.slug)}" class="hover:underline">
              {link.name}
            </a>
          {/each}
        </p>
      {/if}

      <p class="text-text-muted flex items-center gap-2">
        <CalendarDays size={16} class="shrink-0" />
        {formatEventRange(event)}
      </p>

      {#if associationLogoSrc(event.imageUrl)}
        <!-- THE POSTER IS THE INFORMATION, so it is shown whole. `object-cover` in a 13rem box cut
             an A4 poster (ratio 0.707, what an association actually posts) from the bottom up -
             exactly the band carrying the date, the place and the price. The modal has no
             dimensions to reserve a shape from, so it states a CEILING and lets the contained
             picture set its own height; the remainder is the picture again, blurred. -->
        <LetterboxedImage
          src={associationLogoSrc(event.imageUrl) ?? ''}
          alt={m.calendar_event_poster_alt()}
          class="border-cn-border/40 rounded-xl border"
          imgClass="max-h-[60svh]"
        />
      {/if}

      {#if event.description?.trim()}
        <div class="border-cn-border/50 bg-cn-bg/30 rounded-xl border p-3">
          <ProfileBioMarkdown source={event.description} />
        </div>
      {/if}

      {#if event.linkedFormId}
        <a
          href="/forms/{encodeURIComponent(event.linkedFormId)}"
          class="border-cn-border bg-cn-bg text-text-main hover:border-cn-yellow/50 inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors"
        >
          <ClipboardList size={14} />
          {m.calendar_event_linked_form()}
        </a>
      {/if}

      {#if linkedPost}
        <a
          href="/posts/{encodeURIComponent(linkedPost.id)}"
          class="border-cn-border bg-cn-bg text-text-main hover:border-cn-yellow/50 inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors"
        >
          <Newspaper size={14} />
          {m.calendar_event_linked_post()}
        </a>
      {/if}

      <div class="border-cn-border/60 flex flex-wrap items-center gap-2 border-t pt-2">
        <AddEventToCalendarButton event={toAgendaExport(event)} />
        {#if canEdit && onEdit}
          <button
            type="button"
            onclick={() => {
              onEdit(event);
              onClose();
            }}
            class="border-cn-border text-text-main hover:bg-cn-bg inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors"
          >
            <Pencil size={14} />
            {m.common_edit_label()}
          </button>
        {/if}
        {#if canEdit && onDelete}
          <button
            type="button"
            onclick={() => onDelete?.(event.id)}
            class="border-red-err/30 text-red-err hover:bg-red-err/10 inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors"
          >
            <Trash2 size={14} />
            {m.common_delete_button()}
          </button>
        {/if}
      </div>
    </div>
  {/if}
</Modal>
