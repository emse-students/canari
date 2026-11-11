<script lang="ts">
  import { PLACE_ICONS } from '$lib/navigation/placeIcons';
  import { MOBILE_NAV_PLACES, resolveActivePlaceId } from '$lib/navigation/places';
  import { placeBadge } from '$lib/navigation/placeBadge.svelte';
  import { m } from '$lib/paraglide/messages';
  import { page } from '$app/state';
  import { preloadRouteOnView } from '$lib/actions/preloadRouteOnView';
  import { guideAnchor } from '$lib/guidance/guideAnchors.svelte';

  const pathname = $derived(page.url.pathname);
  const activePlaceId = $derived(resolveActivePlaceId(pathname));

  function getIcon(icon: keyof typeof PLACE_ICONS) {
    return PLACE_ICONS[icon];
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

  `touch-manipulation` BECAUSE A TAB TAP WAITED FOR A DOUBLE TAP THAT NEVER COMES. The bar sits
  outside `.page-scroll-wrap`, whose `pan-y pinch-zoom` is what turns double-tap zoom off for the
  page (app.css), so a tap here was held until the double-tap window closed: on the Mi 9T's trace the
  `click` came 120 ms after `touchend`, ~300 ms after the finger landed. `manipulation` keeps pinch
  and pan and drops only the double tap; with it the click followed `touchend` by 27 ms (2026-10-15,
  community-open-budget).
-->
<!-- THE ACTIVE PLACE IS AN INK GLYPH ON A YELLOW PILL (owner, 2026-11-09, option B): the accent
     alone is 1.66:1 on the bar and as a glyph only 3.37:1, so the cue is the pill AND the ink glyph
     (10.35:1 on it). The hit area stays the whole 44px+ column; the pill is only paint. -->
<nav
  id="bottom-nav"
  class="bg-cn-surface fixed inset-x-0 bottom-0 z-30 touch-manipulation border-t border-black/5 shadow-[0_-4px_24px_rgba(0,0,0,0.02)] md:hidden dark:border-white/10 dark:shadow-[0_-4px_24px_rgba(0,0,0,0.2)]"
  data-guide-chrome
  style="padding-bottom: var(--safe-area-inset-bottom, 0px)"
>
  <div class="flex h-(--bottom-nav-height) items-stretch justify-around">
    {#each MOBILE_NAV_PLACES as place (place.id)}
      {@const PlaceIcon = getIcon(place.icon)}
      {@const isActive = place.id === activePlaceId}
      {@const badge = placeBadge(place.id, isActive)}

      <a
        href={place.href}
        use:preloadRouteOnView={place.href}
        use:guideAnchor={`nav.${place.id}`}
        data-app-place={place.href}
        class="group relative flex min-w-0 flex-1 items-center justify-center transition-all duration-200 active:scale-95
 {isActive ? '' : 'text-text-muted hover:text-text-main'}"
      >
        <span
          data-active-pill={isActive ? '' : undefined}
          class="relative inline-flex h-8 w-14 items-center justify-center rounded-full motion-safe:transition-[transform,background-color] motion-safe:duration-300 {isActive
            ? 'bg-accent text-on-accent'
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
