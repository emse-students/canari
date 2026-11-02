/**
 * TEST SUPPORT for `GuideOverlay.svelte.test.ts`, never imported by the app: a stand-in for
 * `globalChatSingleton.svelte` whose session is REACTIVE, so a test can start a call under a tour
 * already on screen and watch the overlay react. A `.svelte.ts` module of its own because the test
 * re-imports Svelte after every `vi.resetModules` - a `$state` created in the test file would belong
 * to the previous runtime and the component would never see it change.
 */
export const globalSession = $state({ isLoggedIn: true, callState: 'idle' as string });
