/**
 * Build-time feature switches.
 *
 * A switch here is a DELIBERATE hold on a surface that already ships, never a fallback and never a
 * runtime toggle: it is a constant, so an off surface costs one branch the bundler folds away, and
 * turning it back on is a one-line commit rather than an archaeology exercise.
 *
 * Every switch MUST name three things in its doc comment: what it turns off, WHY it is off, and the
 * condition that turns it back on. A switch without a stated revival condition is dead code with a
 * nicer name, and the next reader cannot tell the difference.
 */

/**
 * Audio and video calling: the call buttons, the incoming-call UI, and every WebRTC/SFU path
 * behind them ({@link import('./services/CallService').CallService}).
 *
 * **OFF.** The whole calling surface has never been exercised on hardware: the campaign board
 * carries twenty CALL rows and NOT ONE has ever run (`docs/wiki/mechanism-audit.md`), the SFU has
 * never had a peer connection opened against it (measured on prod 2026-09-01: one log line since
 * start, and `resolve_ice_servers()` only runs per peer connection), and no iPhone has ever
 * received a CallKit ring because no iOS device ever registered a PushKit token. App Review then
 * refused the `voip` UIBackgroundModes declaration under guideline 2.5.4 for a feature it could not
 * locate - correctly, on the build it tested. Shipping a surface in that state costs users a button
 * that may fail in ways nothing here can observe.
 *
 * **Turns back on when** rung 15 CALL and CALL-13 have both passed on real hardware
 * (`docs/wiki/cross-client-testing.md`). Flipping this constant is the whole revival: the code
 * underneath is untouched and still tested. The iOS `voip` background mode, the PushKit registry in
 * `canari_push.mm` and Android's `USE_FULL_SCREEN_INTENT` were removed alongside it and must come
 * back in the same commit - see `docs/wiki/frontend/modules/calls.md`.
 */
export const CALLS_ENABLED = false;
