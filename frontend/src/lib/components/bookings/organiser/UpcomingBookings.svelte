<script lang="ts">
  import { onMount } from 'svelte';
  import { X } from '@lucide/svelte';
  import {
    cancelBooking,
    upcomingSpaceBookings,
    type BookerSpace,
    type OrganiserBooking,
  } from '$lib/bookings/api';
  import { formatTimeRange } from '$lib/bookings/grid';
  import { columnsHidden } from '$lib/bookings/columns';
  import { upcomingDays } from '$lib/bookings/dashboard';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import { showToast } from '$lib/stores/toast.svelte';
  import Textarea from '$lib/components/ui/Textarea.svelte';
  import { BOOKING_NOTIFICATIONS_LIVE } from '$lib/bookings/notified';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * THE DASHBOARD'S "COMING" LIST (WP-R5, D50): the space's live bookings that have not ended, by
   * start - the one under way first - with who booked and who comes, read from
   * `GET spaces/:id/bookings?from=now`, so the next ones are never behind the space's history,
   * grouped under the day each starts on (today, tomorrow, then the date - the mockup's list). Each
   * coming one has its cancel IN PLACE (the organiser's, D5): "Annuler" opens the row's own
   * confirmation, "Garder" closes it - no dialog over the list. A page is {@link PAGE} rows; "show
   * more" reads the next one.
   */
  interface Props {
    space: BookerSpace;
    /** The device's clock: what "under way" means on screen, never a rule. */
    nowMs: number;
    /** Called after a cancel, so the week drawn beside the list is read again. */
    onChanged: () => void;
  }

  let { space, nowMs, onChanged }: Props = $props();

  const PAGE = 50;

  let items = $state<OrganiserBooking[]>([]);
  let nextOffset = $state<number | null>(null);
  let loading = $state(true);
  let error = $state('');
  /** The row whose cancel is open, and whether its request is under way. */
  let confirming = $state<string | null>(null);
  let cancelling = $state(false);
  /** The organiser's optional word to the booking's people (Q-R3), carried by their notice only. */
  let message = $state('');
  const MESSAGE_MAX = 500;

  /** Opens one row's cancel with an EMPTY word: a word typed for another row never travels here. */
  function openCancel(id: string) {
    confirming = id;
    message = '';
  }
  /** The instant the first page was read from: later pages continue THAT list. */
  let fromMs = 0;

  const showColumn = $derived(!columnsHidden(space.name, space.resources));
  const columnName = $derived(new Map(space.resources.map((r) => [r.id, r.name])));
  const days = $derived(upcomingDays(items, space.timeZone, nowMs));

  onMount(() => {
    void reload();
  });

  /** The list from now, first page; called again after every change. */
  export async function reload() {
    Log.d('BOOKINGS', `dashboard upcoming read space=${space.id.slice(0, 8)}`);
    fromMs = Date.now();
    loading = true;
    error = '';
    try {
      const page = await upcomingSpaceBookings(space.id, fromMs, 0, PAGE);
      items = page.items;
      nextOffset = page.nextOffset;
    } catch (e) {
      Log.i('BOOKINGS', `dashboard upcoming read failed: ${String(e)}`);
      error = describeBookingRefusal(e, m.common_load_error());
    } finally {
      loading = false;
    }
  }

  async function more() {
    if (nextOffset === null || loading) return;
    loading = true;
    try {
      const page = await upcomingSpaceBookings(space.id, fromMs, nextOffset, PAGE);
      // A booking cancelled meanwhile shifts the pages: never list one id twice.
      const seen = new Set(items.map((b) => b.id));
      items = [...items, ...page.items.filter((b) => !seen.has(b.id))];
      nextOffset = page.nextOffset;
    } catch (e) {
      Log.i('BOOKINGS', `dashboard upcoming next page failed: ${String(e)}`);
      error = describeBookingRefusal(e, m.common_load_error());
    } finally {
      loading = false;
    }
  }

  /** The organiser's cancel, confirmed in its row; a refusal is worded from its code. */
  async function cancel(booking: OrganiserBooking) {
    if (cancelling) return;
    cancelling = true;
    try {
      const word = BOOKING_NOTIFICATIONS_LIVE ? message.trim() : '';
      await cancelBooking(booking.id, word || undefined);
      Log.i('BOOKINGS', `dashboard cancel done booking=${booking.id.slice(0, 8)}`);
      showToast(m.bookings_cancel_done(), 'info');
      confirming = null;
      message = '';
      await reload();
      onChanged();
    } catch (e) {
      Log.i('BOOKINGS', `dashboard cancel refused: ${String(e)}`);
      showToast(describeBookingRefusal(e, m.bookings_cancel_action()), 'error');
    } finally {
      cancelling = false;
    }
  }
</script>

<section class="space-y-3" aria-label={m.bookings_dashboard_tab_upcoming()}>
  {#if error}
    <p
      class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm"
      role="alert"
    >
      {error}
    </p>
  {/if}
  {#if !loading && items.length === 0 && !error}
    <p class="text-text-muted py-8 text-center text-sm">{m.bookings_upcoming_empty()}</p>
  {:else}
    {#each days as day (day.date)}
      <div class="space-y-2">
        <h3 class="text-text-muted text-xs font-semibold first-letter:uppercase">{day.label}</h3>
        <ul class="space-y-2">
          {#each day.items as booking (booking.id)}
            {@const underWay = Date.parse(booking.startsAt) <= nowMs}
            <li class="border-cn-border bg-cn-surface rounded-xl border px-4 py-3">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0 flex-1 space-y-0.5">
                  <p class="text-text-main text-sm font-semibold tabular-nums">
                    {formatTimeRange(
                      Date.parse(booking.startsAt),
                      Date.parse(booking.endsAt),
                      space.timeZone
                    )}
                    {#if underWay}
                      <span
                        class="bg-cn-yellow/25 text-text-main ms-1 rounded-full px-2 py-0.5 text-xs font-bold"
                      >
                        {m.bookings_upcoming_under_way()}
                      </span>
                    {/if}
                  </p>
                  {#if showColumn}
                    <p class="text-text-muted text-xs">
                      {columnName.get(booking.resourceId) ?? ''}
                    </p>
                  {/if}
                  <p class="text-text-main truncate text-sm">
                    {booking.holderName ?? ''}
                    {#if booking.bookedOnBehalf}
                      <span class="text-text-muted text-xs"
                        >· {m.bookings_upcoming_on_behalf()}</span
                      >
                    {/if}
                  </p>
                  {#if booking.participantNames?.length}
                    <p class="text-text-muted truncate text-xs">
                      {m.bookings_upcoming_people({ names: booking.participantNames.join(', ') })}
                    </p>
                  {/if}
                </div>
                {#if !underWay && confirming !== booking.id}
                  <button
                    type="button"
                    onclick={() => openCancel(booking.id)}
                    class="border-cn-border text-red-err hover:border-red-err/40 inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors"
                  >
                    <X size={12} />
                    {m.bookings_upcoming_cancel()}
                  </button>
                {/if}
              </div>
              {#if confirming === booking.id && !underWay}
                <div class="border-cn-border mt-3 space-y-2 border-t pt-3">
                  {#if BOOKING_NOTIFICATIONS_LIVE}
                    <Textarea
                      label={m.bookings_upcoming_cancel_message_label({
                        name: booking.holderName ?? '',
                      })}
                      bind:value={message}
                      maxlength={MESSAGE_MAX}
                      rows={2}
                      disabled={cancelling}
                    />
                    <p class="text-text-muted text-2xs -mt-1 text-right tabular-nums">
                      {m.bookings_upcoming_cancel_message_counter({
                        count: message.length,
                        max: MESSAGE_MAX,
                      })}
                    </p>
                    <p class="text-text-muted text-xs">
                      {m.bookings_upcoming_cancel_notified({ name: booking.holderName ?? '' })}
                    </p>
                  {:else}
                    <p class="text-text-muted text-xs">{m.bookings_cancel_confirm_organiser()}</p>
                  {/if}
                  <div class="flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      disabled={cancelling}
                      onclick={() => {
                        confirming = null;
                        message = '';
                      }}
                      class="border-cn-border text-text-main hover:border-cn-yellow/40 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-40"
                    >
                      {m.bookings_cancel_keep()}
                    </button>
                    <button
                      type="button"
                      disabled={cancelling}
                      onclick={() => void cancel(booking)}
                      class="bg-red-err text-cn-surface rounded-lg px-3 py-2 text-xs font-semibold transition-opacity hover:opacity-90 disabled:opacity-40"
                    >
                      {m.bookings_cancel_action()}
                    </button>
                  </div>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/each}
    {#if nextOffset !== null}
      <div class="flex justify-center">
        <button
          type="button"
          disabled={loading}
          onclick={() => void more()}
          class="border-cn-border text-text-main hover:border-cn-yellow/40 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-40"
        >
          {m.bookings_upcoming_more()}
        </button>
      </div>
    {/if}
  {/if}
</section>
