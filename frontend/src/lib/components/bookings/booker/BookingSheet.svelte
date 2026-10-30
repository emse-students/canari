<script lang="ts">
  import { untrack } from 'svelte';
  import { CalendarClock, Minus, Plus, X } from '@lucide/svelte';
  import Modal from '$lib/components/shared/Modal.svelte';
  import UserAutocomplete from '$lib/components/shared/UserAutocomplete.svelte';
  import FormQuestion from '$lib/components/forms/FormQuestion.svelte';
  import Toggle from '$lib/components/ui/Toggle.svelte';
  import {
    book,
    uploadBookingAnswerFile,
    type BookerResource,
    type BookerSpace,
    type SlotUnit,
  } from '$lib/bookings/api';
  import { formatBookingRange, formatTimeRange } from '$lib/bookings/grid';
  import { describeBookingRefusal, outcomeUnknown } from '$lib/bookings/refusals';
  import {
    firstMissingAnswer,
    initialSelections,
    missingAnswerMessage,
    visibleAnswers,
    visibleItems,
  } from '$lib/forms/fillAnswers';
  import { m } from '$lib/paraglide/messages';
  import { BOOKING_NOTIFICATIONS_LIVE } from '$lib/bookings/notified';
  import { reminderFromValue, reminderOptions, reminderValue } from '$lib/bookings/reminder';
  import { showToast } from '$lib/stores/toast.svelte';
  import { refusalCode } from '$lib/utils/apiRefusal';
  import { Log } from '$lib/utils/Log';

  /**
   * BOOKING ONE RANGE OF ONE RESOURCE (D4, D7, D20, D34, D36). `run` is the free units from the one
   * tapped, as many as one booking may cover: a slot alone, or up to `maxSteps` steps - the reader
   * picks how far it goes. The people, the questions and - for an organiser - the account it is
   * booked for are fixed at booking time: the sheet says so, since a holder can only cancel (D36).
   * Every rule is the server's; the sheet only spares a request it knows would be refused.
   */
  interface Person {
    id: string;
    displayName: string | null;
  }

  interface Props {
    space: BookerSpace;
    resource: BookerResource;
    run: SlotUnit[];
    /** How many of `run`'s units the range starts with: a drag over the grid already chose its length. */
    initialCount?: number;
    /** Offered to whoever may mark the range unavailable instead. */
    onBlockInstead?: () => void;
    /**
     * The DEVICE's clock puts the start outside the booking window. Said, never enforced: the
     * device may be wrong, and the server answers the request on its own clock.
     */
    windowNote: boolean;
    /** Re-reads the grid and the reader's bookings, the sheet staying open. */
    onReread: () => Promise<void>;
    /** `changed`: a booking was made, or the grid is known stale (a slot taken meanwhile). */
    onClose: (changed: boolean) => void;
  }

  let {
    space,
    resource,
    run,
    initialCount = 1,
    onBlockInstead,
    windowNote,
    onReread,
    onClose,
  }: Props = $props();

  const items = $derived(space.items);
  const hidden = $derived(new Set(space.hiddenItemIds));

  let count = $state(untrack(() => Math.max(1, Math.min(initialCount, run.length))));
  let participants = $state<Person[]>([]);
  let onBehalf = $state(false);
  let holder = $state<Person | null>(null);
  /** The booker's own reminder (Q-R1), the space's default until they pick another. */
  let reminder = $state(untrack(() => reminderValue(space.reminderMinutes ?? null)));
  // The sheet is mounted per opening, so the questions it starts from are its first ones.
  let selections = $state(initialSelections(untrack(() => space.items)));
  let submitting = $state(false);
  let error = $state('');
  /** The FILE questions uploading now, by item id: the booking waits for every file to have its id. */
  let uploads = $state<Record<string, boolean>>({});
  const uploading = $derived(Object.values(uploads).some(Boolean));

  const shown = $derived(visibleItems(items, selections, hidden));
  const first = $derived(run[0]);
  const last = $derived(run[Math.min(count, run.length) - 1]);
  /** People besides the holder this booking may still take (D4: the cap counts the holder). */
  const roomLeft = $derived(
    space.maxPeople === null ? Infinity : space.maxPeople - 1 - participants.length
  );
  const mayAddPeople = $derived(space.maxPeople === null || space.maxPeople > 1);

  const lengthOptions = $derived(
    run.map((unit, i) => ({
      value: String(i + 1),
      label: formatTimeRange(run[0].startMs, unit.endMs, space.timeZone),
    }))
  );

  const excluded = $derived([...participants.map((p) => p.id), ...(holder ? [holder.id] : [])]);

  function addParticipant(user: Person) {
    if (roomLeft <= 0 || participants.some((p) => p.id === user.id)) return;
    participants = [...participants, user];
  }

  async function submit() {
    if (submitting || uploading) return;
    error = '';
    if (onBehalf && !holder) {
      error = m.bookings_sheet_holder_missing();
      return;
    }
    const missing = firstMissingAnswer(shown, selections);
    if (missing) {
      error = missingAnswerMessage(missing);
      return;
    }
    submitting = true;
    try {
      const { id } = await book(space.id, {
        resourceId: resource.id,
        startsAt: new Date(first.startMs).toISOString(),
        endsAt: new Date(last.endMs).toISOString(),
        ...(participants.length ? { participantIds: participants.map((p) => p.id) } : {}),
        ...(items.length ? { answers: visibleAnswers(shown, selections) } : {}),
        ...(onBehalf && holder ? { holderId: holder.id } : {}),
        // The booker's own delay: never for an account booked on behalf of (the server ignores
        // it there too), and only while notices are live - off, nothing would send it.
        ...(BOOKING_NOTIFICATIONS_LIVE && !onBehalf
          ? { reminderMinutes: reminderFromValue(reminder) }
          : {}),
      });
      Log.i('BOOKINGS', `booked from the sheet id=${id.slice(0, 8)} onBehalf=${onBehalf}`);
      showToast(m.bookings_sheet_done(), 'info');
      onClose(true);
    } catch (e) {
      const code = refusalCode(e);
      if (outcomeUnknown(e)) {
        // Nobody answered, or a 5xx with no code - a timeout, a lost connection, a gateway error:
        // the booking may have been written before the answer was lost. Say so, and show what is
        // true now.
        Log.i('BOOKINGS', `booking outcome unknown: ${String(e)}`);
        error = m.bookings_sheet_outcome_unknown();
        await onReread();
        return;
      }
      error = describeBookingRefusal(e, m.bookings_sheet_submit());
      // The range was taken or closed meanwhile, or the questions changed: the grid is stale.
      if (code === 'slot-taken' || code === 'blocked' || code === 'space-changed') {
        Log.i('BOOKINGS', `the sheet's range went stale: ${code}`);
        showToast(error, 'error');
        onClose(true);
      }
    } finally {
      submitting = false;
    }
  }
</script>

<Modal open title={m.bookings_sheet_title()} topAnchored footerEdge onClose={() => onClose(false)}>
  <div class="space-y-4">
    <div class="border-cn-border bg-cn-bg flex items-start gap-3 rounded-2xl border p-3">
      <CalendarClock size={18} class="text-text-muted mt-0.5 shrink-0" aria-hidden="true" />
      <div class="min-w-0">
        <p class="text-text-main text-sm font-bold first-letter:uppercase">
          {formatBookingRange(first.startMs, last.endMs, space.timeZone)}
        </p>
        <p class="text-text-muted truncate text-xs">
          {resource.name === space.name ? space.name : `${space.name} · ${resource.name}`}
        </p>
      </div>
    </div>

    {#if windowNote}
      <p
        class="border-amber-warn/30 bg-amber-warn/10 text-amber-warn rounded-xl border px-3 py-2 text-xs"
      >
        {m.bookings_sheet_window_note()}
      </p>
    {/if}

    {#if run.length > 1}
      <div class="space-y-1.5">
        <p class="text-text-main text-sm font-semibold">{m.bookings_sheet_length_label()}</p>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="ui-icon-button border-cn-border text-text-main rounded-xl border disabled:opacity-40"
            aria-label={m.bookings_sheet_length_less()}
            disabled={count <= 1}
            onclick={() => (count -= 1)}
          >
            <Minus size={16} />
          </button>
          <span
            class="text-text-main grow text-center text-sm font-bold tabular-nums"
            role="status"
            aria-live="polite"
          >
            {lengthOptions[count - 1]?.label}
          </span>
          <button
            type="button"
            class="ui-icon-button border-cn-border text-text-main rounded-xl border disabled:opacity-40"
            aria-label={m.bookings_sheet_length_more()}
            disabled={count >= run.length}
            onclick={() => (count += 1)}
          >
            <Plus size={16} />
          </button>
        </div>
      </div>
    {/if}

    {#if space.canManage}
      <div class="space-y-3">
        <Toggle
          bind:checked={onBehalf}
          label={m.bookings_sheet_on_behalf_label()}
          hint={m.bookings_sheet_on_behalf_hint()}
        />
        {#if onBehalf}
          {#if holder}
            <p
              class="border-cn-border bg-cn-bg flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm"
            >
              <span class="text-text-main truncate font-semibold">
                {holder.displayName ?? holder.id}
              </span>
              <button
                type="button"
                class="ui-icon-button text-text-muted hover:text-text-main rounded-lg"
                aria-label={m.bookings_sheet_holder_clear()}
                onclick={() => (holder = null)}
              >
                <X size={16} />
              </button>
            </p>
          {:else}
            <UserAutocomplete
              value=""
              inputId="booking-holder"
              placeholder={m.bookings_sheet_holder_placeholder()}
              excludeIds={excluded}
              onValueChange={() => {}}
              onSelect={(user) => (holder = user)}
            />
          {/if}
        {/if}
      </div>
    {/if}

    {#if mayAddPeople}
      <div class="space-y-2">
        <p class="text-text-main text-sm font-semibold">{m.bookings_sheet_people_label()}</p>
        {#if participants.length}
          <ul class="flex flex-wrap gap-2">
            {#each participants as person (person.id)}
              <li
                class="border-cn-border bg-cn-bg inline-flex items-center gap-1 rounded-full border py-1 pr-1 pl-3 text-sm"
              >
                <span class="text-text-main max-w-48 truncate">
                  {person.displayName ?? person.id}
                </span>
                <button
                  type="button"
                  class="ui-icon-button text-text-muted hover:text-text-main rounded-full"
                  aria-label={m.bookings_sheet_person_remove({
                    name: person.displayName ?? person.id,
                  })}
                  onclick={() => (participants = participants.filter((p) => p.id !== person.id))}
                >
                  <X size={14} />
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if roomLeft > 0}
          <UserAutocomplete
            value=""
            inputId="booking-participants"
            placeholder={m.bookings_sheet_people_placeholder()}
            clearOnSelect
            excludeIds={excluded}
            onValueChange={() => {}}
            onSelect={addParticipant}
          />
        {:else}
          <p class="text-text-muted text-xs">
            {m.bookings_sheet_people_full({ max: space.maxPeople ?? 0 })}
          </p>
        {/if}
        <p class="text-text-muted text-xs">
          {BOOKING_NOTIFICATIONS_LIVE
            ? m.bookings_sheet_people_note_notified()
            : m.bookings_sheet_people_note()}
        </p>
      </div>
    {/if}

    {#if BOOKING_NOTIFICATIONS_LIVE && !onBehalf}
      <div class="space-y-1.5">
        <p id="booking-reminder-label" class="text-text-main text-sm font-semibold">
          {m.bookings_reminder_label()}
        </p>
        <div
          class="flex flex-wrap gap-2"
          role="radiogroup"
          aria-labelledby="booking-reminder-label"
        >
          {#each reminderOptions(reminderFromValue(reminder)) as option (option.value)}
            <button
              type="button"
              role="radio"
              aria-checked={reminder === option.value}
              onclick={() => (reminder = option.value)}
              class="rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors {reminder ===
              option.value
                ? 'bg-cn-yellow text-cn-ink border-cn-yellow'
                : 'border-cn-border text-text-main hover:bg-cn-border/30'}"
            >
              {option.label}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    {#if shown.length}
      <div class="space-y-4">
        {#each shown as item, index (item.id)}
          <FormQuestion
            {item}
            {index}
            bind:value={selections[item.id]}
            disabled={submitting}
            formId={`booking-${space.id}`}
            uploadFile={(itemId, file, transport) =>
              uploadBookingAnswerFile(space.id, itemId, file, transport)}
            fileHint={m.bookings_file_hint({ days: space.retentionDays })}
            fileTooManyError={m.bookings_refusal_files_pending()}
            onUploadingChange={(u) => (uploads[item.id] = u)}
          />
        {/each}
      </div>
    {/if}

    <div class="text-text-muted text-2xs space-y-1">
      <p>{m.bookings_sheet_no_edit_note()}</p>
      {#if space.associationId === null}
        <p>{m.bookings_sheet_personal_note()}</p>
      {/if}
    </div>

    {#if error}
      <p
        class="border-red-err/30 bg-red-err/10 text-red-err rounded-xl border px-4 py-3 text-sm"
        role="alert"
      >
        {error}
      </p>
    {/if}
  </div>

  {#snippet footer()}
    <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      {#if onBlockInstead}
        <button
          type="button"
          onclick={onBlockInstead}
          class="border-cn-border text-text-main hover:border-cn-yellow/40 rounded-xl border px-4 py-2.5 text-sm font-semibold transition-colors"
        >
          {m.bookings_block_action()}
        </button>
      {/if}
      <button
        type="button"
        disabled={submitting || uploading}
        onclick={submit}
        class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover rounded-xl px-4 py-2.5 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      >
        {m.bookings_sheet_submit()}
      </button>
    </div>
  {/snippet}
</Modal>
