<script lang="ts">
  import Modal from '$lib/components/shared/Modal.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import StrandedBookings from '$lib/components/bookings/organiser/StrandedBookings.svelte';
  import {
    addBlock,
    BookingsApiError,
    type BookerResource,
    type BookerSpace,
    type SlotUnit,
  } from '$lib/bookings/api';
  import { formatBookingRange, formatTimeRange } from '$lib/bookings/grid';
  import { strandedIdsOf } from '$lib/bookings/stranded';
  import { describeBookingRefusal, outcomeUnknown } from '$lib/bookings/refusals';
  import { m } from '$lib/paraglide/messages';
  import { showToast } from '$lib/stores/toast.svelte';
  import { refusalCode } from '$lib/utils/apiRefusal';
  import { Log } from '$lib/utils/Log';

  /**
   * "INDISPONIBLE" OVER A RANGE OF ONE RESOURCE (D10, D20): the organiser, or the account linked to
   * the resource. `run` is the free units from the one tapped, at most `BLOCK_LENGTH_CHOICES`; the
   * reader picks how far the block goes, each length naming its end's day when it is not the
   * start's. Blocking a free range is immediate (D29); a range a booking took meanwhile is refused
   * by the server (`bookings-inside-block`), which means the grid is stale: it is re-read. A MANAGER
   * is shown the bookings the refusal named, each with its cancel, and saves again from the list
   * (`StrandedBookings`, as the availability editor does); the resource's linked account may block
   * but not read the space's bookings, so it keeps the count and the re-read grid.
   *
   * An unknown outcome CLOSES the sheet once the grid is re-read: the first block may have landed,
   * and the grid shows it. A second tap would only be refused (`block-overlap`, which also closes
   * the sheet), so the sheet does not offer it.
   */
  interface Props {
    space: BookerSpace;
    resource: BookerResource;
    run: SlotUnit[];
    /** Re-reads the grid and the reader's bookings. */
    onReread: () => Promise<void>;
    onClose: (changed: boolean) => void;
  }

  let { space, resource, run, onReread, onClose }: Props = $props();

  let count = $state(1);
  let reason = $state('');
  let reasonVisible = $state(false);
  let submitting = $state(false);
  let error = $state('');
  /** The bookings a refusal named, listed under the sheet for a manager: a new refusal, a new list. */
  let stranded = $state<{ ids: string[]; key: number }>({ ids: [], key: 0 });

  const first = $derived(run[0]);
  const last = $derived(run[Math.min(count, run.length) - 1]);
  const lengthOptions = $derived(
    run.map((unit, i) => ({
      value: String(i + 1),
      label: formatTimeRange(run[0].startMs, unit.endMs, space.timeZone),
    }))
  );

  async function submit() {
    if (submitting) return;
    submitting = true;
    error = '';
    stranded = { ids: [], key: stranded.key };
    try {
      const text = reason.trim();
      await addBlock(resource.id, {
        startsAt: new Date(first.startMs).toISOString(),
        endsAt: new Date(last.endMs).toISOString(),
        ...(text ? { reason: text, reasonVisible } : {}),
      });
      Log.i('BOOKINGS', `block added resource=${resource.id.slice(0, 8)}`);
      showToast(m.bookings_block_done(), 'info');
      onClose(true);
    } catch (e) {
      const code = refusalCode(e);
      if (outcomeUnknown(e)) {
        // Nobody answered, or a 5xx with no code: the block may have been written before the
        // answer was lost. Re-read, then CLOSE: the grid shows whether it landed.
        Log.i('BOOKINGS', `block outcome unknown: ${String(e)}`);
        await onReread();
        showToast(m.bookings_block_outcome_unknown(), 'error');
        onClose(false);
        return;
      }
      error = describeBookingRefusal(e, m.bookings_block_action());
      const named = strandedIdsOf(e);
      if (named.length && space.canManage) {
        Log.i('BOOKINGS', `block refused, listing ${named.length} booking(s) for the organiser`);
        stranded = { ids: named, key: stranded.key + 1 };
        // The grid behind the sheet is stale too: re-read it while the list stays open.
        await onReread();
        return;
      }
      if (code === 'bookings-inside-block' || code === 'blocked' || code === 'block-overlap') {
        const ids = e instanceof BookingsApiError ? e.bookingIds : [];
        Log.i(
          'BOOKINGS',
          `the block's range went stale: ${code} bookings=${ids.map((id) => id.slice(0, 8)).join(',')}`
        );
        showToast(error, 'error');
        onClose(true);
      }
    } finally {
      submitting = false;
    }
  }
</script>

<Modal
  open
  title={m.bookings_block_title()}
  topAnchored
  footerEdge
  onClose={() => onClose(stranded.key > 0)}
>
  <div class="space-y-5">
    <div>
      <p class="text-text-main text-base font-bold">{resource.name}</p>
      <p class="text-text-muted text-sm first-letter:uppercase">
        {formatBookingRange(first.startMs, last.endMs, space.timeZone)}
      </p>
    </div>

    {#if run.length > 1}
      <Select
        label={m.bookings_block_length_label()}
        value={String(count)}
        options={lengthOptions}
        onValueChange={(v) => (count = Number(v))}
      />
    {/if}

    <Input
      id="booking-block-reason"
      label={m.bookings_block_reason_label()}
      placeholder={m.bookings_block_reason_placeholder()}
      bind:value={reason}
      maxlength={500}
    />
    <Toggle
      bind:checked={reasonVisible}
      disabled={!reason.trim()}
      label={m.bookings_block_reason_visible_label()}
      hint={m.bookings_block_reason_visible_hint()}
    />

    {#if error}
      <p
        class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-4 py-3 text-sm"
        role="alert"
      >
        {error}
      </p>
    {/if}
    {#if stranded.ids.length}
      {#key stranded.key}
        <StrandedBookings
          spaceId={space.id}
          ids={stranded.ids}
          resources={[{ id: resource.id, name: resource.name }]}
          timeZone={space.timeZone}
          onRetry={submit}
        />
      {/key}
    {/if}
  </div>

  {#snippet footer()}
    <div class="flex justify-end">
      <button
        type="button"
        disabled={submitting}
        onclick={submit}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-4 py-2.5 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        {m.bookings_block_action()}
      </button>
    </div>
  {/snippet}
</Modal>
