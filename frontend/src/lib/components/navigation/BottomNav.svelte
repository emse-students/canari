<script lang="ts">
  import {
    MessageCircle,
    Newspaper,
    Users,
    LayoutDashboard,
    Bell,
    Calendar,
    ShoppingBag,
    ClipboardList,
  } from '@lucide/svelte';
  import { APP_PLACES, resolveActivePlaceId } from '$lib/navigation/places';
  import { m } from '$lib/paraglide/messages';
  import { globalConvs, globalSession } from '$lib/stores/globalChatSingleton.svelte';
  import { postNotifStore } from '$lib/stores/postNotifStore.svelte';
  import { totalUnreadMessages } from '$lib/utils/unreadTotal';
  import { page } from '$app/state';

  const pathname = $derived(page.url.pathname);
  const activePlaceId = $derived(resolveActivePlaceId(pathname));

  const ICONS = {
    'message-circle': MessageCircle,
    newspaper: Newspaper,
    users: Users,
    'layout-dashboard': LayoutDashboard,
    bell: Bell,
    calendar: Calendar,
    'shopping-bag': ShoppingBag,
    'clipboard-list': ClipboardList,
  } as const;

  function getIcon(icon: keyof typeof ICONS) {
    return ICONS[icon];
  }

  const totalUnread = $derived(
    globalSession.isLoggedIn ? totalUnreadMessages(globalConvs.conversations.values()) : 0
  );

  /**
   * Unread badge count for a given place.
   *
   * The bar draws the four `mobileNav` places, and `chat` is the only one of them that can carry a
   * badge - which is why the dot's `aria-label` is the unread-MESSAGES sentence. The notifications
   * branch is the rule for a place that is not currently drawn here; giving it a badge in this bar
   * means giving it a sentence of its own too.
   */
  function placeBadge(placeId: string, isActive: boolean): number {
    if (isActive) return 0;
    if (placeId === 'chat') return totalUnread;
    if (placeId === 'notifications' && globalSession.isLoggedIn) return postNotifStore.unread;
    return 0;
  }
</script>

<nav
  id="bottom-nav"
  class="bg-cn-surface fixed inset-x-0 bottom-0 z-30 border-t border-black/5 shadow-[0_-4px_24px_rgba(0,0,0,0.02)] md:hidden dark:border-white/10 dark:shadow-[0_-4px_24px_rgba(0,0,0,0.2)]"
  style="padding-bottom: var(--safe-area-inset-bottom, 0px)"
>
  <div class="flex h-16 items-stretch justify-around">
    {#each APP_PLACES.filter((p) => p.mobileNav) as place (place.id)}
      {@const PlaceIcon = getIcon(place.icon)}
      {@const isActive = place.id === activePlaceId}
      {@const badge = placeBadge(place.id, isActive)}

      <a
        href={place.href}
        data-sveltekit-preload-code="viewport"
        class="group relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 py-1 transition-all duration-200 active:scale-95
 {isActive ? 'text-amber-600 dark:text-amber-400' : 'text-text-muted hover:text-text-main'}"
      >
        <span
          class="relative transition-transform duration-300 {isActive
            ? '-translate-y-0.5'
            : 'group-hover:scale-110'}"
        >
          <PlaceIcon size={24} strokeWidth={isActive ? 2.5 : 2} />

          {#if badge > 0}
            <span
              class="dark:ring-cn-ink absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-red-500 shadow-sm ring-2 ring-white"
              aria-label={m.chat_unread_messages_label({ count: badge })}
            ></span>
          {/if}
        </span>

        <!--
          `shortLabel`, NOT `label`. A cell here is a quarter of the window - 90px at 360px - and
          the long name does not fit at the 12px type floor: see `AppPlace.shortLabel`. `truncate`
          stays as the last line of defence for a translation nobody measured, which is exactly what
          `bottomNavLabels.test.ts` is there to stop reaching.
        -->
        <span
          class="text-2xs max-w-full truncate leading-none font-bold transition-opacity duration-200 {isActive
            ? 'opacity-100'
            : 'font-medium opacity-70'}"
        >
          {place.shortLabel()}
        </span>

        {#if isActive}
          <span
            class="absolute bottom-0 left-1/2 h-1 w-8 -translate-x-1/2 rounded-t-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]"
          ></span>
        {/if}
      </a>
    {/each}
  </div>
</nav>
