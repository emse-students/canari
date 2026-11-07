<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import AddEventToCalendarButton from '$lib/components/calendar/AddEventToCalendarButton.svelte';
  import { Download, Pencil } from '@lucide/svelte';
  import {
    downloadBookingAnswerFile,
    type BookerResource,
    type BookerSpace,
    type MyBooking,
    type SlotUnit,
  } from '$lib/bookings/api';
  import {
    bookingCalendarEvent,
    bookingIcsUrl,
    cancelWithConfirm,
    liftBlockWithConfirm,
    withdrawWithConfirm,
  } from '$lib/bookings/bookingActions';
  import { formatBookingRange } from '$lib/bookings/grid';
  import { bookingPlace } from '$lib/bookings/columns';
  import { bookingOthers, othersNames } from '$lib/bookings/others';
  import { answerText } from '$lib/forms/answerText';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import { m } from '$lib/paraglide/messages';
  import { BOOKING_NOTIFICATIONS_LIVE } from '$lib/bookings/notified';
  import { showToast } from '$lib/stores/toast.svelte';
  import { downloadDecryptedFile } from '$lib/utils/fileDownload';
  import { Log } from '$lib/utils/Log';

  /**
   * WHAT A TAKEN UNIT IS, AND WHAT THE READER MAY DO WITH IT. A booking: its people as the space's
   * visibility allows (D9), its private texts to its people (D32), its answers to the organiser,
   * and cancel (holder, organiser), leave (participant) or "Add to my calendar" (D13). A block: its
   * reason when shown, and lifting it for whoever may. "Modifier" (owner, 2026-11-02, superseding
   * D36) is offered to exactly who may cancel, and only when the parent could build the edit's
   * choices from the week it holds (`onEdit`).
   */
  interface Props {
    space: BookerSpace;
    resource: BookerResource;
    unit: SlotUnit;
    /** The reader's own row of this booking (`GET bookings/mine`): holder or participant. */
    mine: MyBooking | undefined;
    nowMs: number;
    onClose: (changed: boolean) => void;
    /** Opens the booking sheet in edit mode; absent when the edit cannot be offered. */
    onEdit?: () => void;
  }

  let { space, resource, unit, mine, nowMs, onClose, onEdit }: Props = $props();

  const booking = $derived(unit.state === 'booked' ? unit.booking : null);
  /** The holder has their own line above, and the viewer is never listed as one of "the others". */
  const invitees = $derived(
    booking ? bookingOthers(booking).filter((p) => p.id !== booking.holderId) : []
  );
  const coming = $derived(booking ? Date.parse(booking.startsAt) > nowMs : false);
  const isHolder = $derived(mine?.holder ?? false);
  const isParticipant = $derived(!!booking?.mine && !isHolder);
  const mayCancel = $derived(coming && (isHolder || space.canManage));
  const mayWithdraw = $derived(coming && isParticipant && !mine?.withdrawn);
  /**
   * The answers, to the organiser only (the server sends them to nobody else). A FILE answer reads
   * as the name its file was uploaded under, with a download, or as "file deleted" once the purge
   * (or its uploader's erasure) took it - never as its id.
   */
  const answers = $derived.by(() => {
    if (!booking?.answers) return [];
    const words = {
      file: m.form_answer_file(),
      fileDeleted: m.form_answer_file_deleted(),
      deletedFiles: new Set(booking.deletedFileIds ?? []),
    };
    return space.items.flatMap((item) => {
      const value = booking.answers?.[item.id];
      if (value === undefined) return [];
      const fileId =
        item.type === 'file' && typeof value === 'string' && !words.deletedFiles.has(value)
          ? value
          : null;
      const text = (fileId && booking.fileNames?.[fileId]) || answerText(value, item, words);
      return [{ label: item.label, text, fileId }];
    });
  });

  let downloading = $state<string | null>(null);

  async function download(fileId: string, fileName: string) {
    if (!booking || downloading) return;
    downloading = fileId;
    Log.d('BOOKINGS', `answer file download booking=${booking.id.slice(0, 8)}`);
    try {
      await downloadDecryptedFile(await downloadBookingAnswerFile(booking.id, fileId), fileName);
    } catch (e) {
      Log.i('BOOKINGS', `answer file download refused: ${String(e)}`);
      showToast(describeBookingRefusal(e, m.form_answer_file_download()), 'error');
    } finally {
      downloading = null;
    }
  }

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
          {formatBookingRange(unit.startMs, unit.endMs, space.timeZone)}
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
          {#if invitees.length}
            <div>
              <dt class="text-text-muted text-xs font-semibold">{m.bookings_detail_people()}</dt>
              <dd class="text-text-main">{othersNames(invitees)}</dd>
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
              {#if answer.fileId}
                {@const fileId = answer.fileId}
                <!-- The whole row is the download: a long file name is cut, never broken letter by
                     letter at 200 % text, and the full name is its title. -->
                <dd>
                  <button
                    type="button"
                    disabled={downloading !== null}
                    onclick={() => download(fileId, answer.text)}
                    class="border-cn-border text-text-main hover:border-cn-yellow/40 flex w-full min-w-0 items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors disabled:opacity-50"
                    title={answer.text}
                    aria-label={`${m.form_answer_file_download()} - ${answer.text}`}
                  >
                    <Download size={16} class="text-text-muted shrink-0" />
                    <span class="min-w-0 flex-1 truncate">{answer.text}</span>
                  </button>
                </dd>
              {:else}
                <dd class="text-text-main whitespace-pre-line">{answer.text}</dd>
              {/if}
            </div>
          {/each}
        </dl>
      {/if}

      {#if coming && space.canManage && !isHolder}
        <p class="text-text-muted text-xs">
          {BOOKING_NOTIFICATIONS_LIVE
            ? m.bookings_detail_organiser_cancel_note_notified()
            : m.bookings_detail_organiser_cancel_note()}
        </p>
      {/if}
    {:else if unit.state === 'blocked' && unit.blockReason}
      <p class="text-text-main whitespace-pre-line">{unit.blockReason}</p>
    {/if}

    <div class="flex flex-wrap items-center gap-2">
      {#if booking?.mine && coming}
        <span class="inline-flex items-center gap-1">
          <AddEventToCalendarButton
            event={bookingCalendarEvent(booking, bookingPlace(space.name, resource.name))}
            resolveIcsUrl={() => bookingIcsUrl(booking.id)}
          />
          <span class="text-text-muted text-xs">{m.calendar_add_title()}</span>
        </span>
      {/if}
      {#if mayWithdraw}
        <Button variant="secondary" onclick={withdraw}>
          {m.bookings_withdraw_action()}
        </Button>
      {/if}
      {#if mayCancel && onEdit}
        <Button variant="secondary" onclick={onEdit}>
          <Pencil size={16} aria-hidden="true" />
          {m.bookings_edit_action()}
        </Button>
      {/if}
      {#if mayCancel}
        <Button variant="secondary" onclick={cancel}>
          {m.bookings_cancel_action()}
        </Button>
      {/if}
      {#if unit.state === 'blocked' && unit.blockId && unit.endMs > nowMs}
        <Button variant="secondary" onclick={lift}>
          {m.bookings_block_lift_action()}
        </Button>
      {/if}
    </div>
  </div>
</Modal>
