<script lang="ts">
  import { CalendarClock } from '@lucide/svelte';
  import type { MyBooking } from '$lib/bookings/api';
  import { formatBookingRange } from '$lib/bookings/grid';
  import { m } from '$lib/paraglide/messages';

  /**
   * "VOS RESERVATIONS ICI" (D45): the reader's coming bookings in THIS space, beside the week on a
   * desktop and under it on a phone, so the answer to "did I book this?" is on the page that books.
   * The rows come from `mineHere` over the read the page already holds; cancelling or changing one
   * is the Reservations page's, which each row's card there carries.
   */
  interface Props {
    bookings: MyBooking[];
  }

  let { bookings }: Props = $props();
</script>

<section class="border-cn-border bg-cn-surface rounded-2xl border" data-testid="mine-here">
  <h2 class="text-text-main px-4 pt-3 pb-2 text-base font-bold">
    {m.bookings_mine_here_heading()}
  </h2>
  {#if bookings.length === 0}
    <p class="text-text-muted px-4 pb-4 text-xs">{m.bookings_mine_here_empty()}</p>
  {:else}
    <ul class="divide-cn-border divide-y">
      {#each bookings as booking (booking.id)}
        <li class="flex items-center gap-3 px-4 py-3">
          <span
            class="bg-cn-yellow text-cn-ink flex size-8 shrink-0 items-center justify-center rounded-full"
            aria-hidden="true"
          >
            <CalendarClock size={16} />
          </span>
          <div class="min-w-0">
            <p class="text-text-main text-sm font-semibold first-letter:uppercase">
              {formatBookingRange(
                Date.parse(booking.startsAt),
                Date.parse(booking.endsAt),
                booking.space.timeZone
              )}
            </p>
            {#if booking.participantNames?.length}
              <p class="text-text-muted truncate text-xs">
                {m.bookings_card_with({ names: booking.participantNames.join(', ') })}
              </p>
            {:else if booking.resource.name !== booking.space.name}
              <p class="text-text-muted truncate text-xs">{booking.resource.name}</p>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>
