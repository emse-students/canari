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
