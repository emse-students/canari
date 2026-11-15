<!--
  A POST'S CALENDAR EVENT, IN THE ONE CARD FAMILY (`AttachmentCard`, owner 2026-11-15). It used to be
  an amber pill ABOVE the text ("Événement : titre - date"), the one attachment drawn before what the
  author wrote and the one that was not a card. It is now a card in the card zone like the others:
  a calendar-page tile (month and day), the "Événement" chip, the title, the date and hour. It opens
  the agenda on the event (`postEventHref`).
-->
<script lang="ts">
  import AttachmentCard from '$lib/components/shared/AttachmentCard.svelte';
  import { postEventHref } from '$lib/calendar/postEventLink';
  import type { PostLinkedCalendarEvent } from '$lib/posts/api';
  import { intlLocale } from '$lib/utils/intlLocale';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The post the event is linked to: the agenda finds the event from it. */
    postId: string;
    event: PostLinkedCalendarEvent;
    /** Drawn large, with its call to action: the post's only attachment. */
    hero?: boolean;
  }

  let { postId, event, hero = false }: Props = $props();

  const starts = $derived(new Date(event.startsAt));
  const month = $derived(starts.toLocaleString(intlLocale(), { month: 'short' }));
  const day = $derived(starts.toLocaleString(intlLocale(), { day: 'numeric' }));
  const when = $derived(
    starts.toLocaleString(intlLocale(), {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
  );
</script>

{#snippet tile()}
  <div class="flex flex-col items-center leading-none" data-event-date-tile>
    <span class="text-2xs text-accent-text font-bold uppercase">{month}</span>
    <span class="text-text-main text-xl font-bold">{day}</span>
  </div>
{/snippet}

<AttachmentCard
  kind="event"
  href={postEventHref(postId)}
  chip={m.attachment_chip_event()}
  title={event.title}
  subtitle={when}
  {tile}
  {hero}
  heroAction={m.attachment_event_open()}
/>
