<script lang="ts">
  import { internalPath } from '$lib/utils/internalPath';
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import { CalendarDays, LayoutDashboard, Link, QrCode } from '@lucide/svelte';
  import PageContainer from '$lib/components/layout/PageContainer.svelte';
  import PageHeader from '$lib/components/layout/PageHeader.svelte';
  import SpacePoster from '$lib/components/bookings/SpacePoster.svelte';
  import EmptyState from '$lib/components/shared/EmptyState.svelte';
  import QrCodeModal from '$lib/components/shared/QrCodeModal.svelte';
  import SpaceWeek from '$lib/components/bookings/booker/SpaceWeek.svelte';
  import { getSpace, type BookerSpace } from '$lib/bookings/api';
  import { zoneDiffersFromDevice } from '$lib/bookings/grid';
  import { redrawEveryMinuteAndAt } from '$lib/bookings/redrawClock';
  import { describeBookingRefusal } from '$lib/bookings/refusals';
  import { BOOKINGS_HREF, spaceDashboardHref, spaceHref } from '$lib/bookings/routes';
  import { setPageTitle } from '$lib/seo/pageTitle.svelte';
  import { copyPublicShareLink } from '$lib/utils/copyShareLink';
  import { publicAppUrl } from '$lib/utils/publicAppUrl';
  import { exactDate } from '$lib/utils/time';
  import { m } from '$lib/paraglide/messages';
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
      loadError = describeBookingRefusal(e, m.common_load_error());
    } finally {
      if (id === spaceId) loading = false;
    }
  }
</script>

<PageContainer width="tool">
  <PageHeader
    title={space?.name ?? m.bookings_page_title()}
    subtitle={space?.description ?? undefined}
    crumbs={space
      ? [
          { label: m.bookings_page_title(), href: BOOKINGS_HREF },
          { label: space.name, href: spaceHref(space.id) },
        ]
      : undefined}
  >
    {#snippet actions()}
      {#if space}
        <div class="flex items-center gap-1">
          <button
            type="button"
            class="ui-icon-button text-text-muted hover:text-text-main hover:bg-cn-border/30 rounded-lg"
            aria-label={m.bookings_space_copy_link()}
            title={m.bookings_space_copy_link()}
            onclick={() => space && void copyPublicShareLink(spaceHref(space.id))}
          >
            <Link size={18} />
          </button>
          <button
            type="button"
            class="ui-icon-button text-text-muted hover:text-text-main hover:bg-cn-border/30 rounded-lg"
            aria-label={m.qr_button()}
            title={m.qr_button()}
            onclick={() => (qrOpen = true)}
          >
            <QrCode size={18} />
          </button>
          {#if space.canManage}
            <a
              href={resolve(internalPath(spaceDashboardHref(space.id)))}
              class="ui-icon-button text-text-muted hover:text-text-main hover:bg-cn-border/30 rounded-lg"
              aria-label={m.bookings_space_manage()}
              title={m.bookings_space_manage()}
            >
              <LayoutDashboard size={18} />
            </a>
          {/if}
        </div>
      {/if}
    {/snippet}
  </PageHeader>

  {#if space?.poster}
    <div class="mb-4">
      <SpacePoster poster={space.poster} alt={m.bookings_poster_alt({ name: space.name })} />
    </div>
  {/if}

  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div
        class="border-cn-yellow h-8 w-8 animate-spin rounded-full border-4 border-t-transparent"
      ></div>
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
        <SpaceWeek {space} bind:nowMs />
      {/key}

      <p class="text-text-muted text-xs">{m.bookings_space_no_notification_note()}</p>
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
