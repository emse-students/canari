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
    SlidersHorizontal,
  } from '@lucide/svelte';
  import { m } from '$lib/paraglide/messages';
  import { afterNavigate } from '$app/navigation';
  import { APP_PLACES, resolveActivePlaceId } from '$lib/navigation/places';
  import { globalConvs, globalSession } from '$lib/stores/globalChatSingleton.svelte';
  import { postNotifStore } from '$lib/stores/postNotifStore.svelte';
  import { totalUnreadMessages } from '$lib/utils/unreadTotal';
  import { page } from '$app/state';
  import { fade } from 'svelte/transition';

  const pathname = $derived(page.url.pathname);
  const activePlaceId = $derived(resolveActivePlaceId(pathname));

  let isExpanded = $state(false);
  let isHovering = false; // Tracks whether the cursor is physically over the sidebar.
  let expandTimer: ReturnType<typeof setTimeout>;

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

  // Hover intent: short delay before expanding to avoid accidental opens when the cursor crosses the bar.
  function handleMouseEnter() {
    isHovering = true;
    expandTimer = setTimeout(() => {
      isExpanded = true;
    }, 150);
  }

  function handleMouseLeave() {
    isHovering = false;
    clearTimeout(expandTimer);
    isExpanded = false;
  }

  afterNavigate(() => {
    // Collapse the sidebar after navigation only when the cursor has left it.
    if (!isHovering) {
      isExpanded = false;
    }
  });
</script>

<!-- Dimmed backdrop shown when the sidebar is expanded (smooth transition). -->
{#if isExpanded}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!--
    NAMED, because it is the thing that COVERS. `isExpanded` goes false the moment the pointer
    leaves the rail, but this element survives its own 300 ms fade and keeps taking every click
    underneath it for that whole time - so the rail's state does not answer "can I click yet" and
    the only honest answer is whether this div is still in the document. Without the name the
    question could only be asked as a geometry poll against a Tailwind class string.
  -->
  <div
    data-nav-backdrop
    class="fixed inset-0 top-[calc(3.5rem+env(safe-area-inset-top))] z-[22] hidden bg-black/10 backdrop-blur-[2px] md:block dark:bg-black/30"
    transition:fade={{ duration: 300, easing: (t) => t * (2 - t) }}
    onclick={() => (isExpanded = false)}
  ></div>
{/if}

<!--
  NAMED LANDMARK. Two `<aside>` elements are on screen at once - this rail and the conversation
  list - and an unnamed complementary landmark is announced as just "complementary", so assistive
  technology offered the user two identical, indistinguishable regions. The name is also what lets a
  harness address one of them without resorting to pixel widths.
-->
<aside
  aria-label={m.nav_main_landmark()}
  onmouseenter={handleMouseEnter}
  onmouseleave={handleMouseLeave}
  class="app-nav-rail fixed top-[env(safe-area-inset-top)] left-0 hidden h-[calc(var(--app-viewport-height,100dvh)-env(safe-area-inset-top))] flex-col overflow-hidden border-r border-black/5 bg-white/70 shadow-[4px_0_24px_rgba(0,0,0,0.02)] backdrop-blur-2xl transition-all duration-300 ease-out md:flex dark:border-white/10 dark:bg-black/80 dark:shadow-[4px_0_24px_rgba(0,0,0,0.2)]
    {isExpanded ? 'z-30 w-64' : 'z-20 w-[4.5rem]'}"
>
  <nav class="flex flex-1 flex-col gap-1.5 p-3 pt-[4.5rem]">
    {#each APP_PLACES as place (place.id)}
      {@const PlaceIcon = getIcon(place.icon)}
      {@const isActive = place.id === activePlaceId}
      {@const unread = (() => {
        if (isActive) return 0;
        if (place.id === 'chat') return totalUnread;
        if (place.id === 'notifications' && globalSession.isLoggedIn) return postNotifStore.unread;
        return 0;
      })()}

      <a
        href={place.href}
        data-sveltekit-preload-code="viewport"
        title={isExpanded ? undefined : place.label()}
        aria-current={isActive ? 'page' : undefined}
        class="group relative flex h-12 w-full items-center gap-4 overflow-hidden rounded-2xl px-3 text-left transition-all duration-200
          {isActive
          ? 'bg-amber-500/15 text-amber-700 shadow-sm shadow-amber-500/5 hover:bg-amber-500/25 dark:bg-amber-400/10 dark:text-amber-400 dark:hover:bg-amber-400/20'
          : 'text-text-muted hover:text-text-main hover:bg-black/10 dark:hover:bg-white/10'}"
      >
        <!-- Narrow left accent bar for the active item. -->
        {#if isActive}
          <div
            class="absolute top-1/2 left-0 h-6 w-1 -translate-y-1/2 rounded-r-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]"
          ></div>
        {/if}

        <!-- Icon container with scale-on-hover effect. -->
        <span
          class="relative flex w-7 flex-shrink-0 items-center justify-center transition-transform duration-300 group-hover:scale-110"
        >
          <PlaceIcon size={22} strokeWidth={isActive ? 2.5 : 2} />

          <!-- Red dot mini-badge shown when the sidebar is collapsed. -->
          {#if unread > 0 && !isExpanded}
            <span
              class="dark:ring-cn-ink absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-(--surface-elevated)"
            ></span>
          {/if}
        </span>

        <!-- Label with slide-in animation and a short delay to avoid clipping during collapse. -->
        <span
          class="min-w-0 flex-1 overflow-hidden transition-all duration-300 ease-out
            {isExpanded
            ? 'translate-x-0 opacity-100 delay-75'
            : '-translate-x-4 opacity-0 delay-0'}"
        >
          <span class="block truncate text-[0.9rem] leading-tight font-bold whitespace-nowrap">
            {place.label()}
          </span>
          <span
            class="mt-0.5 block truncate text-xs leading-snug font-medium whitespace-nowrap opacity-70"
          >
            {place.description()}
          </span>
        </span>

        <!-- Full count badge, visible only when the sidebar is expanded. -->
        {#if unread > 0}
          <span
            class="ml-auto inline-flex flex-shrink-0 items-center justify-center rounded-full bg-red-500 px-2 py-0.5 text-[0.7rem] leading-none font-bold text-white shadow-sm shadow-red-500/30 transition-all duration-300
              {isExpanded ? 'scale-100 opacity-100 delay-100' : 'scale-75 opacity-0'}"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        {/if}
      </a>
    {/each}
  </nav>

  <!-- Settings, pinned at the bottom (desktop entry point to /settings). -->
  {#if globalSession.isLoggedIn}
    {@const settingsActive = pathname.startsWith('/settings')}
    <div class="border-t border-black/5 p-3 dark:border-white/10">
      <a
        href="/settings"
        data-sveltekit-preload-code="viewport"
        title={isExpanded ? undefined : m.settings_page_title()}
        aria-current={settingsActive ? 'page' : undefined}
        class="group relative flex h-12 w-full items-center gap-4 overflow-hidden rounded-2xl px-3 text-left transition-all duration-200
          {settingsActive
          ? 'bg-amber-500/15 text-amber-700 shadow-sm shadow-amber-500/5 hover:bg-amber-500/25 dark:bg-amber-400/10 dark:text-amber-400 dark:hover:bg-amber-400/20'
          : 'text-text-muted hover:text-text-main hover:bg-black/10 dark:hover:bg-white/10'}"
      >
        {#if settingsActive}
          <div
            class="absolute top-1/2 left-0 h-6 w-1 -translate-y-1/2 rounded-r-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]"
          ></div>
        {/if}

        <span
          class="relative flex w-7 flex-shrink-0 items-center justify-center transition-transform duration-300 group-hover:scale-110"
        >
          <SlidersHorizontal size={22} strokeWidth={settingsActive ? 2.5 : 2} />
        </span>

        <span
          class="min-w-0 flex-1 overflow-hidden transition-all duration-300 ease-out
            {isExpanded
            ? 'translate-x-0 opacity-100 delay-75'
            : '-translate-x-4 opacity-0 delay-0'}"
        >
          <span class="block truncate text-[0.9rem] leading-tight font-bold whitespace-nowrap">
            {m.settings_page_title()}
          </span>
          <span
            class="mt-0.5 block truncate text-xs leading-snug font-medium whitespace-nowrap opacity-70"
          >
            {m.settings_page_subtitle()}
          </span>
        </span>
      </a>
    </div>
  {/if}
</aside>
