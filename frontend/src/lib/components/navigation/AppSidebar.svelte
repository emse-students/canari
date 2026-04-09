<script lang="ts">
  import { MessageCircle, Newspaper, Users, LayoutDashboard } from 'lucide-svelte';
  import { goto, afterNavigate } from '$app/navigation';
  import { APP_PLACES, resolveActivePlaceId } from '$lib/navigation/places';
  import { globalConvs, globalSession } from '$lib/stores/globalChatSingleton.svelte';
  import { page } from '$app/state';
  import { fade } from 'svelte/transition';

  const pathname = $derived(page.url.pathname);
  const activePlaceId = $derived(resolveActivePlaceId(pathname));

  let isExpanded = $state(false);
  let isHovering = false; // Permet de savoir si la souris est physiquement sur la barre
  let expandTimer: ReturnType<typeof setTimeout>;

  const ICONS = {
    'message-circle': MessageCircle,
    newspaper: Newspaper,
    users: Users,
    'layout-dashboard': LayoutDashboard,
  } as const;

  function getIcon(icon: keyof typeof ICONS) {
    return ICONS[icon];
  }

  const totalUnread = $derived(
    globalSession.isLoggedIn
      ? [...globalConvs.conversations.values()].reduce((sum, c) => sum + (c.unreadCount ?? 0), 0)
      : 0
  );

  // Intention de survol : on attend un court instant avant d'ouvrir
  // pour éviter les ouvertures accidentelles quand on traverse l'écran
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
    // Ne ferme la barre après une navigation QUE si la souris n'est plus dessus
    if (!isHovering) {
      isExpanded = false;
    }
  });
</script>

<!-- Fond assombri lors du survol (avec transition douce) -->
{#if isExpanded}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="fixed inset-0 top-14 z-20 hidden md:block bg-black/10 dark:bg-black/30 backdrop-blur-[2px]"
    transition:fade={{ duration: 300, easing: t => t * (2 - t) }}
    onclick={() => (isExpanded = false)}
  ></div>
{/if}

<aside
  onmouseenter={handleMouseEnter}
  onmouseleave={handleMouseLeave}
  class="fixed hidden md:flex flex-col left-0 top-14 h-[calc(100dvh-3.5rem)] border-r border-black/5 dark:border-white/10 bg-white/70 dark:bg-black/30 backdrop-blur-2xl overflow-hidden transition-all duration-300 ease-out shadow-[4px_0_24px_rgba(0,0,0,0.02)] dark:shadow-[4px_0_24px_rgba(0,0,0,0.2)]
    {isExpanded ? 'w-64 z-30' : 'w-[4.5rem] z-20'}"
>
  <nav class="flex flex-col p-3 flex-1 gap-1.5 pt-4">
    {#each APP_PLACES as place (place.id)}
      {@const PlaceIcon = getIcon(place.icon)}
      {@const isActive = place.id === activePlaceId}
      {@const unread = place.id === 'chat' && activePlaceId !== 'chat' ? totalUnread : 0}

      <button
        type="button"
        onclick={() => goto(place.href)}
        title={isExpanded ? undefined : place.label}
        aria-current={isActive ? 'page' : undefined}
        class="group relative flex items-center gap-4 h-12 rounded-2xl px-3 text-left transition-all duration-200 w-full overflow-hidden
          {isActive
          ? 'bg-amber-500/15 hover:bg-amber-500/25 dark:bg-amber-400/10 dark:hover:bg-amber-400/20 text-amber-700 dark:text-amber-400 shadow-sm shadow-amber-500/5'
          : 'text-text-muted hover:bg-black/10 dark:hover:bg-white/10 hover:text-text-main'}"
      >
        <!-- Petite barre latérale d'accentuation pour l'élément actif -->
        {#if isActive}
          <div class="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-amber-500 rounded-r-full shadow-[0_0_8px_rgba(245,158,11,0.6)]"></div>
        {/if}

        <!-- Conteneur d'icône avec effet de zoom au survol -->
        <span class="relative flex-shrink-0 w-7 flex items-center justify-center transition-transform duration-300 group-hover:scale-110">
          <PlaceIcon size={22} strokeWidth={isActive ? 2.5 : 2} />

          <!-- Petit point rouge (mini badge) quand non étendu -->
          {#if unread > 0 && !isExpanded}
            <span class="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-[var(--surface-elevated)] dark:ring-[#151B2C]"></span>
          {/if}
        </span>

        <!-- Texte avec effet de glissement et léger délai pour éviter l'écrasement -->
        <span
          class="min-w-0 flex-1 overflow-hidden transition-all duration-300 ease-out
            {isExpanded ? 'opacity-100 translate-x-0 delay-75' : 'opacity-0 -translate-x-4 delay-0'}"
        >
          <span class="block text-[0.9rem] font-bold leading-tight truncate whitespace-nowrap">
            {place.label}
          </span>
          <span class="block text-xs font-medium opacity-70 leading-snug mt-0.5 truncate whitespace-nowrap">
            {place.description}
          </span>
        </span>

        <!-- Badge compteur complet quand étendu -->
        {#if unread > 0}
          <span
            class="ml-auto flex-shrink-0 inline-flex items-center justify-center rounded-full bg-red-500 px-2 py-0.5 text-[0.7rem] font-bold text-white leading-none shadow-sm shadow-red-500/30 transition-all duration-300
              {isExpanded ? 'opacity-100 scale-100 delay-100' : 'opacity-0 scale-75'}"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        {/if}
      </button>
    {/each}
  </nav>
</aside>
