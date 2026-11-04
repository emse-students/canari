/**
 * Where the iOS native tab bar's state stands - `failed` is what hands the bottom back to the web bar.
 *
 * Its own module, and not the `module` script of `NativeTabBar.svelte` that writes it (which
 * re-exports it): a reader that only needs the FACT must not import the component's graph. The
 * guided help reads it from `guidance.svelte.ts`, which sign-out imports, and the component's graph
 * reaches `globalChatSingleton` and so back to sign-out - an import cycle that left a binding
 * uninitialised at load (`accountSwitchLateFlush.test.ts`, CI of #2952).
 */
export const nativeTabBar = $state<{ status: 'pending' | 'native' | 'failed' }>({
  status: 'pending',
});

/**
 * Whether a MODAL web layer covers the page right now - the guided tour's backdrop, while it is on
 * screen (a suspended tour draws nothing and blocks nothing). The iOS native bar is drawn ABOVE the
 * WebView, so no backdrop can cover it: `NativeTabBar` reads this and tells the plugin to stop taking
 * touches, so a tap on a tab under the tour reaches the backdrop instead of leaving the tour
 * (iPhone 12, `1.6.3-alpha.7`). Written by `GuideOverlay`, the one renderer of the backdrop.
 */
export const modalWebLayer = $state<{ covering: boolean }>({ covering: false });
