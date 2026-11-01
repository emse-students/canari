<script lang="ts">
  import { Bell, CalendarClock } from '@lucide/svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import MyBookingCard from '$lib/components/bookings/booker/MyBookingCard.svelte';
  import type { MyBooking } from '$lib/bookings/api';
  import { bookingPlace } from '$lib/bookings/columns';
  import { bookingWhen, reminderTime } from '$lib/bookings/bookingRow';
  import { BOOKING_NOTIFICATIONS_LIVE } from '$lib/bookings/notified';
  import { m } from '$lib/paraglide/messages';

  /**
   * ONE OF THE READER'S BOOKINGS as a ROW of the Reservations home (mockup D01): a 40px tile, the
   * date and hours on one line, the space and who else is in it muted underneath, and on the right
   * the bell chip with the time the reminder fires - or, for a booking that is over, cancelled or
   * left, its status. Nothing destructive lives in the list: tapping the row opens the booking's
   * detail (`MyBookingCard`: the private texts, the calendar, the reminder, cancel or leave).
   */
  interface Props {
    booking: MyBooking;
    nowMs: number;
    /** A cancel or a withdrawal went through: the list is re-read. */
    onChanged: () => void;
  }

  let { booking, nowMs, onChanged }: Props = $props();

  let open = $state(false);

  const startMs = $derived(Date.parse(booking.startsAt));
  const live = $derived(!booking.cancelled && !booking.withdrawn);
  const coming = $derived(live && startMs > nowMs);
  const when = $derived(
    bookingWhen(startMs, Date.parse(booking.endsAt), booking.space.timeZone, nowMs)
  );
  const sub = $derived(
    [
      bookingPlace(booking.space.name, booking.resource.name),
      booking.participantNames?.length
        ? m.bookings_row_with({ names: booking.participantNames.join(', ') })
        : null,
    ]
      .filter(Boolean)
      .join(' · ')
  );
  /** The chip's text: the reminder's time while one is set, the status of a closed booking. */
  const chip = $derived(
    booking.cancelled
      ? m.bookings_status_cancelled()
      : booking.withdrawn
        ? m.bookings_status_withdrawn()
        : null
  );
  const bell = $derived(
    coming && booking.mine && BOOKING_NOTIFICATIONS_LIVE
      ? reminderTime(startMs, booking.reminderMinutes ?? null, booking.space.timeZone)
      : null
  );
</script>

<button
  type="button"
  class="hover:bg-cn-border/20 flex w-full items-center gap-3 p-4 text-left transition-colors"
  onclick={() => (open = true)}
>
  <span
    class="bg-cn-yellow/15 text-text-muted flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
    aria-hidden="true"
  >
    <CalendarClock size={20} />
  </span>
  <span class="min-w-0 flex-1">
    <span class="text-text-main block truncate text-sm font-semibold first-letter:uppercase">
      {when}
    </span>
    <span class="text-text-muted block truncate text-xs">{sub}</span>
  </span>
  {#if chip}
    <span
      class="border-cn-border text-text-muted shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold"
    >
      {chip}
    </span>
  {:else if bell}
    <span
      class="bg-cn-border/40 text-text-main inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums"
    >
      <Bell size={14} aria-hidden="true" />
      <span class="sr-only">{m.bookings_row_reminder()}</span>
      {bell}
    </span>
  {/if}
</button>

{#if open}
  <Modal
    open
    title={booking.space.name}
    onClose={() => {
      open = false;
      onChanged();
    }}
  >
    <MyBookingCard
      {booking}
      {nowMs}
      onChanged={() => {
        open = false;
        onChanged();
      }}
    />
  </Modal>
{/if}
