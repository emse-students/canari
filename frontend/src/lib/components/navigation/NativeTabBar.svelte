<script lang="ts" module>
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
  import { PLACE_ICONS } from '$lib/navigation/placeIcons';
  import { classColorHex, lucideIconPng, TAB_ICON_CLASSES } from '$lib/mobile/nativeTabIcons';
  import { themeStore } from '$lib/stores/themeStore.svelte';
  import { Log } from '$lib/utils/Log';

  /**
   * THE BOTTOM BAR AS A NATIVE UITabBar, ON iOS ONLY - Liquid Glass on iOS 26 (user, 2026-09-29).
   *
   * It replaces `BottomNav` in the iOS app and offers the same four places (`MOBILE_NAV_PLACES`),
   * the same GLYPHS (`PLACE_ICONS`, rasterised - user, 2026-09-30) in the text colour, the selected
   * one in the web bar's yellow, and NO tint on the bar itself (both states are drawn coloured). It
   * carries the same unread dot (`placeBadge`), and appears under the same conditions the layout
   * already applies to the web bar, which it receives as `visible`. The web bar is `md:hidden`, so
   * this one hides at the same width.
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
    /**
     * The layout's own rule for the bottom bar: not with the keyboard up, not in an open
     * conversation. The login page does not mount this at all.
     */
    visible: boolean;
  }

  let { visible }: Props = $props();

  const WIDE_QUERY = '(min-width: 48rem)';
  let wide = $state(false);
  let listener: TabSelectedListener | null = null;
  let destroyed = false;
  /** The last badge value sent per place, so a re-render that changes nothing sends nothing. */
  let sentBadges: Record<string, string | undefined> = {};
  /** The rasterised glyphs per place, both states, and the two colours they were drawn in. */
  let icons: Record<string, { normal: string; selected: string }> = {};
  let iconsDrawnIn: string | null = null;

  /**
   * Draws both states of every glyph in the current theme's colours - once per pair of colours.
   *
   * KEYED ON THE COLOURS, NOT ON `themeStore.isDark`: the colours are read off the DOM
   * (`data-theme`, which `app.html` sets before first paint), and this component's `onMount` runs
   * BEFORE the root layout's, so before `themeStore.init()`. On a phone in dark mode the store still
   * said light while the DOM said dark, the dark glyphs were filed as light, and switching to light
   * found "light" already drawn and redrew nothing - the resting glyphs stayed `#e4e6eb` on the light
   * bar until a relaunch (iPhone 12, 2026-10-01). Light -> dark worked because both agreed.
   */
  async function drawIcons() {
    const normal = classColorHex(TAB_ICON_CLASSES.normal);
    const selected = classColorHex(TAB_ICON_CLASSES.selected);
    const colours = `${normal}/${selected}`;
    if (iconsDrawnIn === colours) return;
    const drawn: typeof icons = {};
    for (const place of MOBILE_NAV_PLACES) {
      const glyph = PLACE_ICONS[place.icon];
      drawn[place.id] = {
        normal: await lucideIconPng(glyph, normal),
        selected: await lucideIconPng(glyph, selected),
      };
    }
    icons = drawn;
    iconsDrawnIn = colours;
  }

  /**
   * Bumped on every configuration. The plugin REBUILDS its items when configured, which clears
   * every badge on them - so the badge effect reads this and sends them all again.
   */
  let configurations = $state(0);

  /**
   * (Re)configures the bar: the places, both states of their glyphs in the CURRENT theme's colours,
   * and the current selection - and no `tint`, so the bar's glass keeps its own colour. Idempotent
   * on the plugin side - it updates the mounted bar in place.
   */
  async function configure() {
    await drawIcons();
    const active = activePlaceId;
    await configureTabBar({
      items: MOBILE_NAV_PLACES.map((p) => ({
        id: p.id,
        title: '',
        image: icons[p.id].normal,
        // The Canari patch (`patches/tauri-plugin-system-components`): the selected state's bitmap.
        selectedImage: icons[p.id].selected,
      })),
      selectedId: MOBILE_NAV_PLACES.some((p) => p.id === active)
        ? (active ?? undefined)
        : undefined,
    });
    sentBadges = {};
    configurations++;
  }

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
        await configure();
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

  // The theme decides both colours (the text colour, and `amber-600` / `amber-400`), so a theme
  // change redraws the glyphs and reconfigures the bar. The first run is the mount's own.
  let tintedForDark: boolean | null = null;
  $effect(() => {
    const dark = themeStore.isDark;
    if (nativeTabBar.status !== 'native') return;
    if (tintedForDark === null) {
      tintedForDark = dark;
      return;
    }
    if (tintedForDark === dark) return;
    tintedForDark = dark;
    void configure().catch(logFailure('re-colour'));
  });

  // The unread dot: an EMPTY badge value is UIKit's dot, the web bar's dot - never a count.
  $effect(() => {
    void configurations;
    if (nativeTabBar.status !== 'native') return;
    for (const place of MOBILE_NAV_PLACES) {
      const value = placeBadge(place.id, place.id === activePlaceId) > 0 ? '' : undefined;
      if (place.id in sentBadges && sentBadges[place.id] === value) continue;
      sentBadges[place.id] = value;
      void setBadge(place.id, value).catch(logFailure('badge'));
    }
  });
</script>
