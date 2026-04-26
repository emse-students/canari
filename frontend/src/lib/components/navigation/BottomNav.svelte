<script lang="ts">
  import { MessageCircle, Newspaper, Users, LayoutDashboard } from 'lucide-svelte';
  import { APP_PLACES, resolveActivePlaceId } from '$lib/navigation/places';
  import { globalConvs, globalSession } from '$lib/stores/globalChatSingleton.svelte';
  import { page } from '$app/state';

  const pathname = $derived(page.url.pathname);
  const activePlaceId = $derived(resolveActivePlaceId(pathname));

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
</script>

<nav
  class="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-black/5 dark:border-white/10 bg-white/70 dark:bg-black/30 backdrop-blur-2xl shadow-[0_-4px_24px_rgba(0,0,0,0.02)] dark:shadow-[0_-4px_24px_rgba(0,0,0,0.2)]"
  style="padding-bottom: env(safe-area-inset-bottom)"
>
  <div class="flex items-stretch justify-around h-16">
    {#each APP_PLACES as place (place.id)}
      {@const PlaceIcon = getIcon(place.icon)}
      {@const isActive = place.id === activePlaceId}
      {@const unread = place.id === 'chat' && activePlaceId !== 'chat' ? totalUnread : 0}

      <a
        href={place.href}
        data-sveltekit-preload-code="viewport"
        class="group relative flex flex-col items-center justify-center gap-1 min-w-0 flex-1 py-1 px-1 transition-all duration-200 active:scale-95
          {isActive ? 'text-amber-600 dark:text-amber-400' : 'text-text-muted hover:text-text-main'}"
      >
        <!-- Conteneur de l'icône avec léger soulèvement si actif -->
        <span class="relative transition-transform duration-300 {isActive ? '-translate-y-0.5' : 'group-hover:scale-110'}">
          <PlaceIcon size={24} strokeWidth={isActive ? 2.5 : 2} />

          <!-- Badge rouge pour les messages non lus -->
          {#if unread > 0}
            <span
              class="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-white dark:ring-[#151B2C] shadow-sm"
              aria-label="{unread} messages non lus"
            ></span>
          {/if}
        </span>

        <!-- Texte du label -->
        <span class="text-[10px] font-bold leading-none truncate max-w-full transition-opacity duration-200 {isActive ? 'opacity-100' : 'opacity-70 font-medium'}">
          {place.label}
        </span>

        <!-- Barre indicatrice lumineuse en bas pour l'onglet actif -->
        {#if isActive}
          <span
            class="absolute bottom-0 left-1/2 -translate-x-1/2 h-1 w-8 rounded-t-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]"
          ></span>
        {/if}
      </a>
    {/each}
  </div>
</nav>
