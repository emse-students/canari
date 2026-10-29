<script lang="ts">
  import { onMount } from 'svelte';
  import { RotateCcw, X } from '@lucide/svelte';
  import { cancelBooking, namedSpaceBookings, type BookingView } from '$lib/bookings/api';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import { rangeInZone, STRANDED_PAGE } from '$lib/bookings/stranded';
  import { showConfirm } from '$lib/stores/confirm.svelte';
  import { m } from '$lib/paraglide/messages';
  import { BOOKING_NOTIFICATIONS_LIVE } from '$lib/bookings/notified';
  import { getLocale } from '$lib/paraglide/runtime';
  import { Log } from '$lib/utils/Log';

  /**
   * THE BOOKINGS A D29 REFUSAL NAMED, EACH WITH ITS CANCEL BUTTON (WP-B4). D29 refuses a change
   * while coming bookings fall inside it "naming them": this is where they are named - when, which
   * resource, whose - and where the organiser cancels them explicitly (D20) before retrying. Nobody
   * is notified in v1 (D13), so the screen says so. The parent keys this component by the refusal,
   * so a new refusal is a new list.
   */
  interface Props {
    spaceId: string;
    /** The ids the refusal carried, in its order. */
    ids: string[];
    /** The space's resources, to name each booking's. */
    resources: { id: string; name: string }[];
    /** The space's zone: every time of a space is read on its clock (D25). */
    timeZone: string;
    /** Every named booking is cancelled: the parent saves again. */
    onRetry: () => void;
  }

  let { spaceId, ids, resources, timeZone, onRetry }: Props = $props();

  let rows = $state<BookingView[]>([]);
  let loading = $state(true);
  let error = $state('');
  let cancelling = $state<string | null>(null);

  const locale = $derived(getLocale() === 'en' ? 'en-GB' : 'fr-FR');
  const asked = $derived(ids.slice(0, STRANDED_PAGE));
  const more = $derived(Math.max(ids.length - asked.length, 0));
  const live = $derived(rows.filter((r) => !r.cancelled));
  const resourceName = (id: string) => resources.find((r) => r.id === id)?.name ?? '';
  const when = (b: BookingView) => rangeInZone(b.startsAt, b.endsAt, timeZone, locale);

  onMount(async () => {
    Log.d('BOOKINGS', `stranded list space=${spaceId} named=${ids.length}`);
    try {
      rows = await namedSpaceBookings(spaceId, asked);
    } catch (e) {
      error = describeBookingRefusal(e, m.common_load_error());
    } finally {
      loading = false;
    }
  });

  async function cancel(b: BookingView) {
    if (cancelling) return;
    const question = BOOKING_NOTIFICATIONS_LIVE
      ? m.bookings_stranded_cancel_confirm_notified({ when: when(b) })
      : m.bookings_stranded_cancel_confirm({ when: when(b) });
    const confirmed = await showConfirm(question, {
      danger: true,
      // "Annuler" would name both buttons: the confirm says what it cancels, the other keeps it.
      confirmLabel: m.bookings_stranded_cancel_confirm_button(),
      cancelLabel: m.bookings_stranded_keep(),
    });
    if (!confirmed) return;
    cancelling = b.id;
    error = '';
    try {
      await cancelBooking(b.id);
      Log.i('BOOKINGS', `stranded booking cancelled id=${b.id.slice(0, 8)}`);
      rows = rows.map((r) => (r.id === b.id ? { ...r, cancelled: true } : r));
    } catch (e) {
      error = describeBookingRefusal(e, m.bookings_stranded_cancel());
    } finally {
      cancelling = null;
    }
  }
</script>

<section
  class="border-amber-warn/30 bg-amber-warn/5 space-y-3 rounded-xl border p-3"
  aria-label={m.bookings_stranded_title()}
>
  <h5 class="text-text-main text-sm font-bold">{m.bookings_stranded_title()}</h5>
  <p class="text-text-muted text-xs">
    {BOOKING_NOTIFICATIONS_LIVE ? m.bookings_stranded_hint_notified() : m.bookings_stranded_hint()}
  </p>

  {#if loading}
    <div class="flex justify-center py-3">
      <div
        class="border-cn-yellow h-5 w-5 animate-spin rounded-full border-2 border-t-transparent"
      ></div>
    </div>
  {:else}
    <ul class="space-y-2">
      {#each live as b (b.id)}
        <li
          class="border-cn-border/70 bg-cn-bg flex flex-wrap items-center justify-end gap-2 rounded-xl border px-3 py-2"
        >
          <!-- 12rem before the button wraps under it: at 200 % text the times stay readable. -->
          <div class="min-w-0 grow basis-48 text-sm">
            <p class="text-text-main font-semibold break-words">{when(b)}</p>
            <p class="text-text-muted text-xs break-words">
              {resourceName(b.resourceId)} - {b.holderName ?? m.bookings_stranded_unnamed()}
            </p>
          </div>
          <button
            type="button"
            class="border-red-err/30 text-red-err hover:bg-red-err/10 inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40"
            aria-label={m.bookings_stranded_cancel_aria({ when: when(b) })}
            disabled={cancelling !== null}
            onclick={() => cancel(b)}
          >
            <X size={14} />
            {m.bookings_stranded_cancel()}
          </button>
        </li>
      {/each}
    </ul>
    {#if more}
      <p class="text-text-muted text-xs">{m.bookings_stranded_more({ count: more })}</p>
    {/if}
    {#if !error && live.length === 0}
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-green-ok text-sm" role="status">{m.bookings_stranded_cleared()}</p>
        <button
          type="button"
          onclick={onRetry}
          class="bg-cn-yellow text-cn-ink hover:bg-cn-yellow-hover inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold transition-colors"
        >
          <RotateCcw size={15} />
          {m.bookings_stranded_retry()}
        </button>
      </div>
    {/if}
  {/if}
  {#if error}
    <p class="text-red-err text-xs" role="alert">{error}</p>
  {/if}
</section>
