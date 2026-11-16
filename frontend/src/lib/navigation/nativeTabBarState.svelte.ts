/**
 * Where the iOS native tab bar's state stands - `failed` is what hands the bottom back to the web bar.
 *
 * Its own module, and not the `module` script of `NativeTabBar.svelte` that writes it (which
 * re-exports it): a reader that only needs the FACT must not import the component's graph. The
 * guided help reads it from `guidance.svelte.ts`, which sign-out imports, and the component's graph
 * reaches `globalChatSingleton` and so back to sign-out - an import cycle that left a binding
 * uninitialised at load (`accountSwitchLateFlush.test.ts`, CI of #2952).
 */
export const nativeTabBar = $state<{
  status: 'pending' | 'native' | 'failed';
  /** The band the bar covers at the bottom of the screen, in px, as the plugin last measured it. */
  inset: number;
}>({
  status: 'pending',
  inset: 0,
});

/**
 * THE BAND THE NATIVE TAB BAR COVERS RIGHT NOW, in px - 0 when there is no native bar (web, Android,
 * a bar that failed to configure) or it is hidden.
 *
 * The iOS bar is a UIKit view drawn ABOVE the WebView, so no web z-index puts a floating panel over
 * it: a panel that ends inside this band has its last rows under the bar (iPhone 12, 2026-11-16: the
 * last item of a post's menu and of the profile's). Whatever places a `position: fixed` panel
 * against the viewport subtracts this, as it subtracts the keyboard's band
 * (`computeFixedPopoverPosition`). Android's bar is a DOM element and stacks below the panels, so
 * it is not a band here.
 */
export function currentNativeTabBarInset(): number {
  return nativeTabBar.status === 'native' ? Math.max(0, nativeTabBar.inset) : 0;
}

/**
 * Whether a MODAL web layer covers the page right now - the guided tour's backdrop, while it is on
 * screen (a suspended tour draws nothing and blocks nothing). The iOS native bar is drawn ABOVE the
 * WebView, so no backdrop can cover it: `NativeTabBar` reads this and tells the plugin to stop taking
 * touches, so a tap on a tab under the tour reaches the backdrop instead of leaving the tour
 * (iPhone 12, `1.6.3-alpha.7`). Written by `GuideOverlay`, the one renderer of the backdrop.
 */
export const modalWebLayer = $state<{ covering: boolean }>({ covering: false });
