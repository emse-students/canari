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
  import { globalConvs, globalSession } from '$lib/stores/globalChatSingleton.svelte';
  import { postNotifStore } from '$lib/stores/postNotifStore.svelte';
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
    globalSession.isLoggedIn
      ? [...globalConvs.conversations.values()].reduce((sum, c) => sum + (c.unreadCount ?? 0), 0)
      : 0
  );

  /** Unread badge count for a given place. */
  function placeBadge(placeId: string, isActive: boolean): number {
    if (isActive) return 0;
    if (placeId === 'chat') return totalUnread;
    if (placeId === 'notifications' && globalSession.isLoggedIn) return postNotifStore.unread;
    return 0;
  }
</script>

<nav
  id="bottom-nav"
  class="fixed inset-x-0 bottom-0 z-30 border-t border-black/5 bg-white/70 shadow-[0_-4px_24px_rgba(0,0,0,0.02)] backdrop-blur-2xl md:hidden dark:border-white/10 dark:bg-black/80 dark:shadow-[0_-4px_24px_rgba(0,0,0,0.2)]"
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
        class="group relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 py-1 transition-all duration-200 active:scale-95
          {isActive
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-text-muted hover:text-text-main'}"
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
              aria-label="{badge} non lus"
            ></span>
          {/if}
        </span>

        <span
          class="max-w-full truncate text-[10px] leading-none font-bold transition-opacity duration-200 {isActive
            ? 'opacity-100'
            : 'font-medium opacity-70'}"
        >
          {place.label()}
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
