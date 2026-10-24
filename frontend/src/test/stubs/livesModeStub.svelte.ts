/**
 * A test stand-in for the server's lives kill switch as `/api/version` publishes it: a `$state`, so a
 * component reading `serverLivesMode()` re-renders when a test flips it, as on a version refresh.
 */
export const livesModeStub = $state<{ mode: 'off' | 'on' }>({ mode: 'on' });
