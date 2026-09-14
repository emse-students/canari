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

<!--
  THE BAR DRAWS NO TEXT, AND THE NUMBERS BELOW ARE A MEASUREMENT, NOT A TASTE.

  Read on A1 (Mi 9T, 436 x 945 CSS px, dpr 2.475) on 2026-09-14, against Instagram on the same phone
  in the same minute - its five tabs carry a `content-desc` and NOT ONE `TextView`:

  | | Instagram | Canari, before |
  | --- | --- | --- |
  | bar's own box | 118 real = **47.7** | 64 |
  | + safe-area inset | 59 real = 23.8 | 25 |
  | tab | 216 x 118 real = 87 x 48 | 109 x 64 |
  | glyph | 59 real = **23.8** | **24** |
  | text under the glyph | **none** | 10 px, `text-2xs` |
  | unread mark | **10 real = 4 CSS**, a bare dot centred under the glyph | 10 px + a 2 px white ring = 14 |

  The glyph was already right, so the 16 px this bar gives back is the label row and nothing else.
  THE NAMES ARE NOT DELETED, THEY ARE MADE INVISIBLE: `sr-only` keeps each tab's accessible name -
  and because nothing draws them any more, the name is now the FULL one rather than the shortened
  one the 90 px cell used to force ("Tableau de bord", not "Tableau").

  THE DOT MOVED UNDER THE GLYPH BECAUSE THE LABEL ROW VACATED THAT SPACE, which is where Instagram
  puts it too. Its white ring existed to separate red from a glyph it overlapped at the corner; in
  clear air it separates itself, so the ring goes and the dot can be the small one the reference
  shows rather than a 14 px disc.

  NO ACTIVE UNDERLINE. It was `h-1 w-8` of amber with an 8 px glow, pinned to a bottom edge that is
  now 16 px closer to the glyph, saying what the amber tint and the 2.5 stroke on the glyph itself
  already say. Instagram marks its own tab with the glyph and nothing else.
-->
<nav
  id="bottom-nav"
  class="bg-cn-surface fixed inset-x-0 bottom-0 z-30 border-t border-black/5 shadow-[0_-4px_24px_rgba(0,0,0,0.02)] md:hidden dark:border-white/10 dark:shadow-[0_-4px_24px_rgba(0,0,0,0.2)]"
  style="padding-bottom: var(--safe-area-inset-bottom, 0px)"
>
  <div class="flex h-12 items-stretch justify-around">
    {#each APP_PLACES.filter((p) => p.mobileNav) as place (place.id)}
      {@const PlaceIcon = getIcon(place.icon)}
      {@const isActive = place.id === activePlaceId}
      {@const badge = placeBadge(place.id, isActive)}

      <a
        href={place.href}
        data-sveltekit-preload-code="viewport"
        class="group relative flex min-w-0 flex-1 items-center justify-center transition-all duration-200 active:scale-95
 {isActive ? 'text-amber-600 dark:text-amber-400' : 'text-text-muted hover:text-text-main'}"
      >
        <span
          class="relative transition-transform duration-300 {isActive
            ? ''
            : 'group-hover:scale-110'}"
        >
          <PlaceIcon size={24} strokeWidth={isActive ? 2.5 : 2} />

          {#if badge > 0}
            <span
              class="absolute -bottom-2 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-red-500"
              aria-label={m.chat_unread_messages_label({ count: badge })}
            ></span>
          {/if}
        </span>

        <span class="sr-only">{place.label()}</span>
      </a>
    {/each}
  </div>
</nav>
