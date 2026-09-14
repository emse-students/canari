<script lang="ts">
  import { Bell } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import { createPausableInterval } from '$lib/utils/backgroundPausableInterval';
  import { postNotifStore } from '$lib/stores/postNotifStore.svelte';
  import { m } from '$lib/paraglide/messages';

  /*
   * THE BELL IS A LINK TO `/notifications`, AND IT USED TO BE THE ONLY THING STANDING IN FRONT OF IT.
   *
   * This component has exactly one caller - `MobileHeader`, which is `md:hidden` - so the 320 px
   * right-anchored dropdown it used to open existed ONLY on a phone, where it is the least suited.
   * Desktop never had it: `AppSidebar` draws every `APP_PLACES` entry including `notifications`, and
   * that entry goes to the route.
   *
   * `notifications` is `mobileNav: false`, so the bottom bar does not draw it either. Measured on A1
   * (Mi 9T, 436 x 945) on 2026-09-14: exactly ONE anchor to `/notifications` existed in the mobile
   * document, the sidebar's, with a 0 x 0 box because its container is `display: none` at that
   * width. **The route was unreachable by any link on the one platform that had the dropdown**, and
   * the dropdown offered no way through to it.
   *
   * The page is also strictly the better screen, which is what makes deleting the dropdown a
   * simplification rather than a trade: it loads 50 rather than a default page, groups by date band,
   * filters all/unread, and holds the "what was unread when I opened this" snapshot so the accents
   * survive the read receipt. The dropdown re-implemented a thinner version of the last of those and
   * none of the rest.
   *
   * What stays here is the only thing the header owes: the unread COUNT, and the poll that keeps it
   * honest while the user is on some other page.
   */

  onMount(() => {
    void postNotifStore.load();
    return createPausableInterval(() => void postNotifStore.load(), 60_000);
  });
</script>

<a
  href="/notifications"
  title={m.nav_notifications_label()}
  aria-label={m.nav_notifications_label()}
  class="text-text-muted hover:text-text hover:bg-cn-surface relative flex h-11 w-11 items-center justify-center rounded-full transition-colors"
>
  <Bell size={24} strokeWidth={2} />
  {#if postNotifStore.unread > 0}
    <span
      class="text-2xs absolute -top-0.5 -right-0.5 flex h-[1.1rem] min-w-[1.1rem] items-center justify-center rounded-full bg-red-500 px-0.5 font-bold text-white"
    >
      {postNotifStore.unread > 9 ? '9+' : postNotifStore.unread}
    </span>
  {/if}
</a>
