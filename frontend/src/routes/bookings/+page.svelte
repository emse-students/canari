<script lang="ts">
  import { onMount } from 'svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import SpaceList from '$lib/components/bookings/booker/SpaceList.svelte';
  import EditBookingsTab from '$lib/components/bookings/organiser/EditBookingsTab.svelte';
  import MyBookingCard from '$lib/components/bookings/booker/MyBookingCard.svelte';
  import { listSpaces, myBookings, type ListedSpace, type MyBooking } from '$lib/bookings/api';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import { redrawEveryMinuteAndAt } from '$lib/bookings/redrawClock';
  import { m } from '$lib/paraglide/messages';
  import { BOOKING_NOTIFICATIONS_LIVE } from '$lib/bookings/notified';
  import { Log } from '$lib/utils/Log';

  /**
   * RESERVATIONS (D16, WP-B5): the reader's coming bookings first, then the spaces listed for them
   * (D31), then their personal spaces, created here. Past, cancelled and left bookings are folded
   * away below. With no notification in v1 (D13), this page is where an organiser's cancellation
   * or being added to a booking (D34) is learnt - it says so.
   */

  let bookings = $state<MyBooking[]>([]);
  let spaces = $state<ListedSpace[]>([]);
  let loading = $state(true);
  let bookingsError = $state('');
  let spacesError = $state('');
  let nowMs = $state(Date.now());

  /** Live and not yet over, soonest first. */
  const coming = $derived(
    bookings
      .filter((b) => !b.cancelled && !b.withdrawn && Date.parse(b.endsAt) > nowMs)
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
  );
  /** Everything else, newest first (the server's order). */
  const history = $derived(bookings.filter((b) => !coming.includes(b)));

  onMount(() => {
    void load();
    // A booking that ends while the page is open moves to the history without a reload.
    return redrawEveryMinuteAndAt(null, (now) => (nowMs = now));
  });

  async function load() {
    Log.d('BOOKINGS', 'reservations page load');
    loading = true;
    await Promise.all([readBookings(), readSpaces()]);
    loading = false;
  }

  async function readBookings() {
    bookingsError = '';
    try {
      bookings = await myBookings();
      nowMs = Date.now();
    } catch (e) {
      Log.i('BOOKINGS', `my bookings read failed: ${String(e)}`);
      bookingsError = describeBookingRefusal(e, m.common_load_error());
    }
  }

  async function readSpaces() {
    spacesError = '';
    try {
      spaces = await listSpaces();
    } catch (e) {
      Log.i('BOOKINGS', `spaces read failed: ${String(e)}`);
      spacesError = describeBookingRefusal(e, m.common_load_error());
    }
  }
</script>

<PageContainer width="tool">
  <PageHeader title={m.bookings_page_title()} subtitle={m.bookings_page_subtitle()} />

  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div
        class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else}
    <div class="space-y-8">
      <section class="space-y-3" aria-labelledby="bookings-mine-heading">
        <h2 id="bookings-mine-heading" class="text-text-main text-lg font-bold tracking-tight">
          {m.bookings_mine_heading()}
        </h2>
        {#if bookingsError}
          <p
            class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm"
            role="alert"
          >
            {bookingsError}
          </p>
        {:else if coming.length === 0}
          <p class="text-text-muted text-sm">{m.bookings_mine_empty()}</p>
        {:else}
          <ul class="space-y-3">
            {#each coming as booking (booking.id)}
              <li><MyBookingCard {booking} {nowMs} onChanged={readBookings} /></li>
            {/each}
          </ul>
        {/if}
        <p class="text-text-muted text-xs">
          {BOOKING_NOTIFICATIONS_LIVE
            ? m.bookings_mine_notification_note()
            : m.bookings_mine_no_notification_note()}
        </p>
        {#if history.length}
          <details class="group">
            <summary
              class="text-text-main cursor-pointer py-2 text-sm font-semibold select-none hover:underline"
            >
              {m.bookings_history_heading({ count: history.length })}
            </summary>
            <ul class="mt-2 space-y-3">
              {#each history as booking (booking.id)}
                <li><MyBookingCard {booking} {nowMs} onChanged={readBookings} /></li>
              {/each}
            </ul>
          </details>
        {/if}
      </section>

      <section class="space-y-3" aria-labelledby="bookings-spaces-heading">
        <h2 id="bookings-spaces-heading" class="text-text-main text-lg font-bold tracking-tight">
          {m.bookings_spaces_heading()}
        </h2>
        {#if spacesError}
          <p
            class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm"
            role="alert"
          >
            {spacesError}
          </p>
        {:else if spaces.length === 0}
          <p class="text-text-muted text-sm">{m.bookings_spaces_empty()}</p>
        {:else}
          <SpaceList {spaces} label={m.bookings_spaces_heading()} />
        {/if}
      </section>

      <EditBookingsTab associationId={null} />
    </div>
  {/if}
</PageContainer>
