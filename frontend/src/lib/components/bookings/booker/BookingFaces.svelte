<script lang="ts">
  import Avatar from '$lib/components/shared/Avatar.svelte';
  import type { BookingPerson } from '$lib/bookings/api';
  import { othersNames, splitBookingFaces } from '$lib/bookings/others';
  import { m } from '$lib/paraglide/messages';

  /**
   * THE OTHER PEOPLE OF A BOOKING: overlapped faces then "Avec : names", the way the agenda stacks
   * an event's associations (`OrganiserFaces`). At most three faces then a `+N` pill; the names
   * truncate to the width the row has, and the whole is ONE `role="img"` carrying the FULL list, so
   * neither the truncation nor the pill hides anyone from a screen reader or a hover. The caller
   * passes `bookingOthers(booking)`: the viewer is never in it.
   */
  interface Props {
    people: BookingPerson[];
  }

  let { people }: Props = $props();

  const faces = $derived(splitBookingFaces(people));
  const names = $derived(othersNames(people));
  const label = $derived(m.bookings_card_with({ names }));
</script>

{#if people.length > 0}
  <div class="flex min-w-0 items-center gap-2" role="img" aria-label={label} title={label}>
    <span class="inline-flex shrink-0 items-center" aria-hidden="true">
      {#each faces.shown as person, i (person.id)}
        <span class="ring-cn-surface rounded-full ring-2 {i > 0 ? '-ml-2' : ''}">
          <Avatar userId={person.id} size="sm" shape="circle" fallbackLabel={person.name} />
        </span>
      {/each}
      {#if faces.hidden.length > 0}
        <span
          class="ring-cn-surface bg-cn-surface-alt text-text-muted text-2xs -ml-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-bold ring-2"
          data-booking-more={faces.hidden.length}
        >
          <span class="text-zoom-exempt">+{faces.hidden.length}</span>
        </span>
      {/if}
    </span>
    <span class="text-text-muted min-w-0 truncate text-xs" aria-hidden="true">{label}</span>
  </div>
{/if}
