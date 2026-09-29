<script lang="ts" module>
  /**
   * The SF Symbol each bar place is drawn with - the native counterpart of `BottomNav`'s Lucide
   * glyph. Keyed by place id, and asserted against `MOBILE_NAV_PLACES` by the component's test, so
   * a fifth place cannot reach the native bar without an icon.
   */
  export const NATIVE_TAB_SYMBOLS: Record<string, string> = {
    posts: 'newspaper',
    communities: 'person.3',
    chat: 'bubble.left.and.bubble.right',
    dashboard: 'square.grid.2x2',
  };

  /** Where the bar's state stands - `failed` is what hands the bottom back to the web bar. */
  export const nativeTabBar = $state<{ status: 'pending' | 'native' | 'failed' }>({
    status: 'pending',
  });
</script>

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    configureTabBar,
    getTabBarInsets,
    hideTabBar,
    onTabSelected,
    removeTabBar,
    selectTab,
    setBadge,
    showTabBar,
    type TabSelectedListener,
  } from '@sosweetham/tauri-plugin-system-components-api';
  import { MOBILE_NAV_PLACES, resolveActivePlaceId } from '$lib/navigation/places';
  import { placeBadge } from '$lib/navigation/placeBadge.svelte';
  import { Log } from '$lib/utils/Log';

  /**
   * THE BOTTOM BAR AS A NATIVE UITabBar, ON iOS ONLY - Liquid Glass on iOS 26 (user, 2026-09-29).
   *
   * It replaces `BottomNav` in the iOS app and offers the same four places (`MOBILE_NAV_PLACES`),
   * the same unread dot (`placeBadge`), and appears under the same conditions the layout already
   * applies to the web bar, which it receives as `visible`. The web bar is `md:hidden`, so this one
   * hides at the same width.
   *
   * ICONS ONLY, AND VOICEOVER NAMES NOTHING - A DECISION, NOT AN OVERSIGHT. The plugin's item title is
   * at once the visible label and the accessible one, and the web bar draws no text; the user chose
   * the icons knowing the tabs are announced without names (2026-09-29). Giving them names back
   * means a title here, or a patched plugin.
   *
   * The space the bar covers is the PLUGIN's answer (`getTabBarInsets`), written to
   * `--bottom-nav-reserve`, which is what `.page-scroll-wrap` and `.mobile-nav-inset` reserve: the
   * floating iOS 26 pill and the classic bar are not the web bar's `4rem`.
   */
  interface Props {
    /** The layout's own rule for the bottom bar: not with the keyboard up, not in an open conversation. The login page does not mount this at all. */
    visible: boolean;
  }

  let { visible }: Props = $props();

  const WIDE_QUERY = '(min-width: 48rem)';
  let wide = $state(false);
  let listener: TabSelectedListener | null = null;
  let destroyed = false;
  /** The last badge value sent per place, so a re-render that changes nothing sends nothing. */
  const sentBadges: Record<string, string | undefined> = {};

  const activePlaceId = $derived(resolveActivePlaceId(page.url.pathname));
  const shown = $derived(visible && !wide);

  async function publishInsets() {
    const { bottom } = await getTabBarInsets();
    document.documentElement.style.setProperty('--bottom-nav-reserve', `${bottom}px`);
    Log.d('NativeTabBar', `bottom inset ${bottom}px`);
  }

  onMount(() => {
    const media = window.matchMedia(WIDE_QUERY);
    wide = media.matches;
    const onWidth = (e: MediaQueryListEvent) => (wide = e.matches);
    media.addEventListener('change', onWidth);
    const onResize = () => {
      if (nativeTabBar.status === 'native') void publishInsets().catch(logFailure('insets'));
    };
    window.addEventListener('resize', onResize);

    void (async () => {
      try {
        const active = activePlaceId;
        await configureTabBar({
          items: MOBILE_NAV_PLACES.map((p) => ({
            id: p.id,
            title: '',
            sfSymbol: NATIVE_TAB_SYMBOLS[p.id],
          })),
          selectedId: MOBILE_NAV_PLACES.some((p) => p.id === active)
            ? (active ?? undefined)
            : undefined,
        });
        listener = await onTabSelected(({ id }) => {
          const place = MOBILE_NAV_PLACES.find((p) => p.id === id);
          Log.d('NativeTabBar', `tab selected: ${id}`);
          if (place) void goto(place.href);
        });
        if (destroyed) return;
        nativeTabBar.status = 'native';
        await publishInsets();
      } catch (e) {
        // A FALLBACK IS A SIGNAL: the web bar comes back so the app keeps its navigation, and the
        // line says the native one is not there - on a build that was meant to have it.
        console.error(
          '[NativeTabBar] the native tab bar could not be configured - showing the web bar:',
          e
        );
        nativeTabBar.status = 'failed';
      }
    })();

    return () => {
      media.removeEventListener('change', onWidth);
      window.removeEventListener('resize', onResize);
    };
  });

  onDestroy(() => {
    destroyed = true;
    void listener?.unregister();
    if (nativeTabBar.status === 'native') void removeTabBar().catch(logFailure('remove'));
    document.documentElement.style.removeProperty('--bottom-nav-reserve');
  });

  function logFailure(what: string) {
    return (e: unknown) => console.warn(`[NativeTabBar] ${what} failed:`, e);
  }

  // Shown / hidden with the layout's rule, and the reserve re-read: a hidden bar covers nothing.
  $effect(() => {
    if (nativeTabBar.status !== 'native') return;
    const show = shown;
    void (show ? showTabBar() : hideTabBar())
      .then(() => publishInsets())
      .catch(logFailure(show ? 'show' : 'hide'));
  });

  // The selection follows the ROUTE, not only the taps. `selectTab` cannot clear a selection, so a
  // page outside the four places (a profile, the calendar) keeps the last one lit.
  $effect(() => {
    if (nativeTabBar.status !== 'native') return;
    const active = activePlaceId;
    if (!active || !MOBILE_NAV_PLACES.some((p) => p.id === active)) return;
    void selectTab(active).catch(logFailure('select'));
  });

  // The unread dot: an EMPTY badge value is UIKit's dot, the web bar's dot - never a count.
  $effect(() => {
    if (nativeTabBar.status !== 'native') return;
    for (const place of MOBILE_NAV_PLACES) {
      const value = placeBadge(place.id, place.id === activePlaceId) > 0 ? '' : undefined;
      if (place.id in sentBadges && sentBadges[place.id] === value) continue;
      sentBadges[place.id] = value;
      void setBadge(place.id, value).catch(logFailure('badge'));
    }
  });
</script>
