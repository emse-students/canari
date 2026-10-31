<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import { Bell, CalendarDays } from '@lucide/svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import Breadcrumb from '$lib/components/navigation/Breadcrumb.svelte';
  import SpaceBanner from '$lib/components/bookings/booker/SpaceBanner.svelte';
  import EmptyState from '$lib/components/shared/EmptyState.svelte';
  import QrCodeModal from '$lib/components/shared/QrCodeModal.svelte';
  import SpaceWeek from '$lib/components/bookings/booker/SpaceWeek.svelte';
  import { getSpace, type BookerSpace } from '$lib/bookings/api';
  import { zoneDiffersFromDevice } from '$lib/bookings/grid';
  import { redrawEveryMinuteAndAt } from '$lib/bookings/redrawClock';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import { refusalCode, refusalStatus } from '$lib/utils/apiRefusal';
  import { BOOKINGS_HREF, spaceHref } from '$lib/bookings/routes';
  import { setPageTitle } from '$lib/seo/pageTitle.svelte';
  import { publicAppUrl } from '$lib/utils/publicAppUrl';
  import { exactDate } from '$lib/utils/time';
  import { m } from '$lib/paraglide/messages';
  import { BOOKING_NOTIFICATIONS_LIVE } from '$lib/bookings/notified';
  import { Log } from '$lib/utils/Log';

  /**
   * THE BOOKER'S PAGE OF ONE SPACE (WP-B5, WP-R2): the poster, the week of one column
   * (`SpaceWeek`, the same one the organiser's dashboard draws in block mode) and the space's link
   * and QR code (D16). The server holds every rule: this page reads what it is sent, draws the
   * booking window on the device's clock - redrawn every minute and at the opening instant - and
   * lets every tap reach the server's answer. Its organiser reaches the dashboard from here (D50).
   */

  const spaceId = $derived(page.params.spaceId ?? '');

  let space = $state<BookerSpace | null>(null);
  let loading = $state(true);
  let loadError = $state('');
  // The server answered that no such space is reachable: a plain page, not a red error.
  let notFound = $state(false);
  let nowMs = $state(Date.now());
  let qrOpen = $state(false);

  const notOpenYet = $derived(
    space?.opensAt && Date.parse(space.opensAt) > nowMs ? space.opensAt : null
  );

  $effect(() => {
    if (!space) return;
    setPageTitle(space.name);
    return () => setPageTitle(null);
  });

  // The route parameter, not the mount: SvelteKit keeps this page from one space to another.
  $effect(() => {
    const id = spaceId;
    untrack(() => void load(id));
  });

  // The device's clock only REDRAWS (a unit drawn bookable or not, the opening notice); the server
  // decides every request on its own.
  $effect(() => {
    const opensAt = space?.opensAt ? Date.parse(space.opensAt) : null;
    return redrawEveryMinuteAndAt(opensAt, (now) => (nowMs = now));
  });

  async function load(id: string) {
    Log.d('BOOKINGS', `space page load space=${id}`);
    loading = true;
    loadError = '';
    notFound = false;
    space = null;
    try {
      const loadedSpace = await getSpace(id);
      // A later navigation owns the page now: this answer is for a space no longer shown.
      if (id !== spaceId) return;
      nowMs = Date.now();
      space = loadedSpace;
    } catch (e) {
      if (id !== spaceId) return;
      Log.i('BOOKINGS', `space read failed space=${id}: ${String(e)}`);
      notFound = refusalStatus(e) === 404 || refusalCode(e) === 'space-not-found';
      loadError = describeBookingRefusal(e, m.common_load_error());
    } finally {
      if (id === spaceId) loading = false;
    }
  }
</script>

<PageContainer width="tool">
  {#if space}
    <Breadcrumb
      crumbs={[
        { label: m.bookings_page_title(), href: BOOKINGS_HREF },
        { label: space.name, href: spaceHref(space.id) },
      ]}
    />
    <SpaceBanner {space} onQr={() => (qrOpen = true)} />
  {:else}
    <PageHeader title={m.bookings_page_title()} />
  {/if}

  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div
        class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
    </div>
  {:else if notFound}
    <div class="flex flex-col items-center gap-4 py-16 text-center">
      <p class="text-text-main text-base">{m.bookings_space_unavailable()}</p>
      <a
        href={resolve('/bookings')}
        class="bg-cn-yellow text-cn-dark rounded-xl px-4 py-2 text-sm font-semibold"
      >
        {m.bookings_space_unavailable_back()}
      </a>
    </div>
  {:else if loadError || !space}
    <p
      class="bg-red-err/10 border-red-err/30 text-red-err rounded-xl border p-4 text-sm"
      role="alert"
    >
      {loadError}
    </p>
  {:else if space.resources.length === 0}
    <EmptyState
      icon={CalendarDays}
      title={m.bookings_space_empty_title()}
      description={m.bookings_space_empty_desc()}
    />
  {:else}
    <div class="space-y-4">
      {#if notOpenYet}
        <p class="border-cn-border bg-cn-bg text-text-main rounded-xl border px-4 py-3 text-sm">
          {m.bookings_space_opens_at({ when: exactDate(notOpenYet) })}
        </p>
      {/if}
      {#if zoneDiffersFromDevice(space.timeZone, nowMs)}
        <p class="text-text-muted text-xs">
          {m.bookings_space_zone_note({ zone: space.timeZone })}
        </p>
      {/if}

      {#key space.id}
        <SpaceWeek {space} bind:nowMs>
          {#snippet aside()}
            <p
              class="border-cn-border bg-cn-surface text-text-muted flex items-start gap-2 rounded-2xl border p-4 text-xs"
            >
              <Bell size={16} class="mt-0.5 shrink-0" aria-hidden="true" />
              {BOOKING_NOTIFICATIONS_LIVE
                ? m.bookings_space_notification_note()
                : m.bookings_space_no_notification_note()}
            </p>
          {/snippet}
        </SpaceWeek>
      {/key}
    </div>
  {/if}
</PageContainer>

{#if space}
  <QrCodeModal
    open={qrOpen}
    url={publicAppUrl(spaceHref(space.id))}
    label={space.name}
    intro={m.bookings_space_qr_intro()}
    onClose={() => (qrOpen = false)}
  />
{/if}
