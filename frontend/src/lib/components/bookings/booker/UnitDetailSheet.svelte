<script lang="ts">
  import { onMount } from 'svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import AddEventToCalendarButton from '$lib/components/calendar/AddEventToCalendarButton.svelte';
  import {
    calendarLink,
    type BookerResource,
    type BookerSpace,
    type MyBooking,
    type SlotUnit,
  } from '$lib/bookings/api';
  import {
    bookingCalendarEvent,
    cancelWithConfirm,
    liftBlockWithConfirm,
    withdrawWithConfirm,
  } from '$lib/bookings/bookingActions';
  import { formatBookingRange, formatDay, formatTimeRange } from '$lib/bookings/grid';
  import { answerText } from '$lib/forms/answerText';
  import { m } from '$lib/paraglide/messages';
  import { Log } from '$lib/utils/Log';

  /**
   * WHAT A TAKEN UNIT IS, AND WHAT THE READER MAY DO WITH IT. A booking: its people as the space's
   * visibility allows (D9), its private texts to its people (D32), its answers to the organiser,
   * and cancel (holder, organiser), leave (participant) or "Add to my calendar" (D13). A block: its
   * reason when shown, and lifting it for whoever may. Nothing here edits a booking (D36).
   */
  interface Props {
    space: BookerSpace;
    resource: BookerResource;
    unit: SlotUnit;
    /** The reader's own row of this booking (`GET bookings/mine`): holder or participant. */
    mine: MyBooking | undefined;
    nowMs: number;
    onClose: (changed: boolean) => void;
  }

  let { space, resource, unit, mine, nowMs, onClose }: Props = $props();

  const booking = $derived(unit.state === 'booked' ? unit.booking : null);
  const coming = $derived(booking ? Date.parse(booking.startsAt) > nowMs : false);
  const isHolder = $derived(mine?.holder ?? false);
  const isParticipant = $derived(!!booking?.mine && !isHolder);
  const mayCancel = $derived(coming && (isHolder || space.canManage));
  const mayWithdraw = $derived(coming && isParticipant && !mine?.withdrawn);
  const answers = $derived(
    booking?.answers
      ? space.items.flatMap((item) => {
          const value = booking.answers?.[item.id];
          return value === undefined ? [] : [{ label: item.label, text: answerText(value, item) }];
        })
      : []
  );

  let icsPath = $state<string | null>(null);

  onMount(() => {
    if (!booking?.mine || !coming) return;
    calendarLink(booking.id)
      .then((r) => (icsPath = r.path))
      .catch((e) => Log.d('BOOKINGS', `no calendar link: ${String(e)}`));
  });

  async function cancel() {
    if (!booking) return;
    if (await cancelWithConfirm(booking.id, !isHolder)) onClose(true);
  }

  async function withdraw() {
    if (!booking) return;
    if (await withdrawWithConfirm(booking.id)) onClose(true);
  }

  async function lift() {
    if (unit.state !== 'blocked' || !unit.blockId) return;
    if (await liftBlockWithConfirm(unit.blockId)) onClose(true);
  }
</script>

<Modal
  open
  title={booking ? m.bookings_detail_title() : m.bookings_cell_blocked()}
  onClose={() => onClose(false)}
>
  <div class="space-y-4 text-sm">
    <div>
      <p class="text-text-main text-base font-bold">{resource.name}</p>
      <p class="text-text-muted first-letter:uppercase">
        {#if booking}
          {formatBookingRange(
            Date.parse(booking.startsAt),
            Date.parse(booking.endsAt),
            space.timeZone
          )}
        {:else}
          {formatDay(unit.date)}, {formatTimeRange(unit.startMs, unit.endMs, space.timeZone)}
        {/if}
      </p>
    </div>

    {#if booking}
      {#if booking.holderName}
        <dl class="space-y-2">
          <div>
            <dt class="text-text-muted text-xs font-semibold">{m.bookings_detail_holder()}</dt>
            <dd class="text-text-main">{booking.holderName}</dd>
          </div>
          {#if booking.participantNames?.length}
            <div>
              <dt class="text-text-muted text-xs font-semibold">{m.bookings_detail_people()}</dt>
              <dd class="text-text-main">{booking.participantNames.join(', ')}</dd>
            </div>
          {/if}
        </dl>
      {:else}
        <p class="text-text-muted">{m.bookings_detail_occupied()}</p>
      {/if}

      {#if mine?.privateInfo?.spacePrivateInfo || mine?.privateInfo?.resourcePrivateInfo}
        <div class="border-cn-border bg-cn-bg space-y-1 rounded-xl border p-3">
          <p class="text-text-muted text-xs font-semibold">{m.bookings_detail_private()}</p>
          {#each [mine.privateInfo.spacePrivateInfo, mine.privateInfo.resourcePrivateInfo] as text, i (i)}
            {#if text}<p class="text-text-main whitespace-pre-line">{text}</p>{/if}
          {/each}
        </div>
      {/if}

      {#if answers.length}
        <dl class="border-cn-border space-y-2 rounded-xl border p-3">
          {#each answers as answer, i (i)}
            <div>
              <dt class="text-text-muted text-xs font-semibold">{answer.label}</dt>
              <dd class="text-text-main whitespace-pre-line">{answer.text}</dd>
            </div>
          {/each}
        </dl>
      {/if}

      {#if coming && space.canManage && !isHolder}
        <p class="text-text-muted text-xs">{m.bookings_detail_organiser_cancel_note()}</p>
      {/if}
    {:else if unit.state === 'blocked' && unit.blockReason}
      <p class="text-text-main whitespace-pre-line">{unit.blockReason}</p>
    {/if}

    <div class="flex flex-wrap items-center gap-2">
      {#if booking?.mine && coming}
        <span class="inline-flex items-center gap-1">
          <AddEventToCalendarButton
            event={bookingCalendarEvent(booking, `${space.name} - ${resource.name}`, icsPath)}
          />
          <span class="text-text-muted text-xs">{m.calendar_add_title()}</span>
        </span>
      {/if}
      {#if mayWithdraw}
        <button
          type="button"
          onclick={withdraw}
          class="border-cn-border text-text-main hover:border-red-err/40 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors"
        >
          {m.bookings_withdraw_action()}
        </button>
      {/if}
      {#if mayCancel}
        <button
          type="button"
          onclick={cancel}
          class="border-red-err/30 text-red-err hover:bg-red-err/10 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors"
        >
          {m.bookings_cancel_action()}
        </button>
      {/if}
      {#if unit.state === 'blocked' && unit.blockId && unit.endMs > nowMs}
        <button
          type="button"
          onclick={lift}
          class="border-cn-border text-text-main hover:border-cn-yellow/40 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors"
        >
          {m.bookings_block_lift_action()}
        </button>
      {/if}
    </div>
  </div>
</Modal>
