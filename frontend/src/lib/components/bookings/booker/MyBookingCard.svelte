<script lang="ts">
  import { resolve } from '$app/paths';
  import AddEventToCalendarButton from '$lib/components/calendar/AddEventToCalendarButton.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import { setBookingReminder, type MyBooking } from '$lib/bookings/api';
  import { BOOKING_NOTIFICATIONS_LIVE } from '$lib/bookings/notified';
  import { reminderFromValue, reminderOptions, reminderValue } from '$lib/bookings/reminder';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import { showToast } from '$lib/stores/toast.svelte';
  import { Log } from '$lib/utils/Log';
  import {
    bookingCalendarEvent,
    bookingIcsUrl,
    cancelWithConfirm,
    withdrawWithConfirm,
  } from '$lib/bookings/bookingActions';
  import { formatBookingRange } from '$lib/bookings/grid';
  import { spaceHref } from '$lib/bookings/routes';
  import { internalPath } from '$lib/utils/internalPath';
  import { bookingPlace } from '$lib/bookings/columns';
  import { m } from '$lib/paraglide/messages';

  /**
   * ONE OF THE READER'S BOOKINGS on the Reservations page: where and when (in the space's zone,
   * D25), the reader's part in it, its private texts while it is live (D32), and - while it is to
   * come - cancel (the holder), leave (a participant), "Add to my calendar" (D13) and, while the
   * notices are live, the reader's OWN reminder delay (Q-R1), saved as soon as it is picked.
   */
  interface Props {
    booking: MyBooking;
    nowMs: number;
    /** A cancel or a withdrawal went through: the list is re-read. */
    onChanged: () => void;
  }

  let { booking, nowMs, onChanged }: Props = $props();

  const startMs = $derived(Date.parse(booking.startsAt));
  const live = $derived(!booking.cancelled && !booking.withdrawn);
  const coming = $derived(live && startMs > nowMs);
  const role = $derived(
    booking.holder
      ? m.bookings_role_holder()
      : booking.linked && !booking.mine
        ? m.bookings_role_linked()
        : m.bookings_role_participant()
  );
  const status = $derived(
    booking.cancelled
      ? m.bookings_status_cancelled()
      : booking.withdrawn
        ? m.bookings_status_withdrawn()
        : null
  );

  async function cancel() {
    if (await cancelWithConfirm(booking.id, false)) onChanged();
  }

  async function withdraw() {
    if (await withdrawWithConfirm(booking.id)) onChanged();
  }

  /** The delay shown; the server's until the reader picks another. */
  let reminder = $state<string | null>(null);
  const reminderShown = $derived(reminder ?? reminderValue(booking.reminderMinutes ?? null));
  let savingReminder = $state(false);

  async function pickReminder(value: string) {
    if (savingReminder) return;
    const before = reminderShown;
    reminder = value;
    savingReminder = true;
    try {
      await setBookingReminder(booking.id, reminderFromValue(value));
      Log.i('BOOKINGS', `reminder set booking=${booking.id.slice(0, 8)} value=${value}`);
      showToast(m.bookings_reminder_saved(), 'info');
    } catch (e) {
      Log.i('BOOKINGS', `reminder refused booking=${booking.id.slice(0, 8)}: ${String(e)}`);
      reminder = before;
      showToast(describeBookingRefusal(e, m.bookings_reminder_label()), 'error');
    } finally {
      savingReminder = false;
    }
  }
</script>

<article class="border-cn-border bg-cn-surface space-y-2 rounded-2xl border p-4 shadow-sm">
  <div class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <a
        href={resolve(internalPath(spaceHref(booking.space.id)))}
        class="text-text-main block truncate text-base font-bold hover:underline"
      >
        {booking.space.name}
      </a>
      <!-- A column named like its space (D44's hidden column) is not read twice. -->
      {#if booking.resource.name !== booking.space.name}
        <p class="text-text-muted truncate text-sm">{booking.resource.name}</p>
      {/if}
    </div>
    <span
      class="border-cn-border text-text-muted shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold"
    >
      {status ?? role}
    </span>
  </div>
  <p class="text-text-main text-sm first-letter:uppercase">
    {formatBookingRange(startMs, Date.parse(booking.endsAt), booking.space.timeZone)}
  </p>
  {#if booking.participantNames?.length}
    <p class="text-text-muted text-xs">
      {m.bookings_card_with({ names: booking.participantNames.join(', ') })}
    </p>
  {/if}
  {#if coming && (booking.privateInfo?.spacePrivateInfo || booking.privateInfo?.resourcePrivateInfo)}
    <div class="bg-cn-bg space-y-1 rounded-xl p-3 text-sm">
      {#each [booking.privateInfo?.spacePrivateInfo, booking.privateInfo?.resourcePrivateInfo] as text, i (i)}
        {#if text}<p class="text-text-main whitespace-pre-line">{text}</p>{/if}
      {/each}
    </div>
  {/if}
  {#if coming && booking.mine && BOOKING_NOTIFICATIONS_LIVE}
    <Select
      label={m.bookings_reminder_label()}
      value={reminderShown}
      options={reminderOptions(reminderFromValue(reminderShown))}
      disabled={savingReminder}
      onValueChange={(v) => void pickReminder(v)}
    />
  {/if}
  {#if coming}
    <div class="flex flex-wrap items-center gap-2 pt-1">
      {#if booking.mine}
        <AddEventToCalendarButton
          event={bookingCalendarEvent(
            booking,
            bookingPlace(booking.space.name, booking.resource.name)
          )}
          resolveIcsUrl={() => bookingIcsUrl(booking.id)}
        />
      {/if}
      {#if booking.holder}
        <button
          type="button"
          onclick={cancel}
          class="border-red-err/30 text-red-err hover:bg-red-err/10 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors"
        >
          {m.bookings_cancel_action()}
        </button>
      {:else if booking.mine}
        <button
          type="button"
          onclick={withdraw}
          class="border-cn-border text-text-main hover:border-red-err/40 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors"
        >
          {m.bookings_withdraw_action()}
        </button>
      {/if}
    </div>
  {/if}
</article>
