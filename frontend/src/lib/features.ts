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

import { deployEnvironment } from '$lib/utils/deployEnvironment';

/**
 * Calling as the STORE BINARIES carry it: the native ring (Android CallStyle + full-screen intent,
 * iOS PushKit/CallKit) and the two store declarations that go with it. Mirrored by `CALLS_ENABLED`
 * in `CanariFirebaseMessagingService.kt` - the push service runs when no webview exists and cannot
 * read this file - and `callsCompiled.test.ts` asserts that it, the ObjC `kCanariCallsEnabled`, the iOS
 * `voip` background mode and Android's `USE_FULL_SCREEN_INTENT` all agree with this constant.
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
export const CALLS_COMPILED = false;

/**
 * In-app 1:1 calling: the call buttons, the in-app ring, and the peer-to-peer WebRTC path behind
 * them ({@link import('./services/CallService').CallService}).
 *
 * **ON FOR A DEV BUILD ONLY (lot 1, 2026-10-17).** A build made for `dev.canari-emse.fr` - the dev
 * web estate and every pre-release app, which the pipelines refuse to point anywhere else - carries
 * `VITE_DEPLOY_ENVIRONMENT=development`, and that is the whole test. Production builds never set it
 * (unset MEANS production, `deployEnvironment.ts`), so a stable can only call once
 * {@link CALLS_COMPILED} is flipped. What is on is the in-app half only: the invite rings an OPEN
 * app over the chat socket; a killed or backgrounded phone is not rung, because the native ring is
 * {@link CALLS_COMPILED}'s and stays off.
 *
 * **Turns into `CALLS_COMPILED` alone when** the revival's Tier B cells pass on real hardware
 * (`docs/wiki/frontend/modules/calls-revival-plan.md` section 7).
 */
export const CALLS_ENABLED = CALLS_COMPILED || deployEnvironment() === 'development';

/**
 * Video in a call: the video-call button and the camera toggle inside a call.
 *
 * **OFF.** Lot 1 of the revival is AUDIO: the E2E transform encrypts the whole frame, header
 * included, which is known to suit Opus and known to break H.264 packetization - and Safari and
 * WKWebView may negotiate H.264. **Turns back on when** the revival's WP-C3 (header-in-clear
 * framing per codec, or VP8 forced) has passed a video call Chrome <-> WKWebView.
 */
export const CALLS_VIDEO_ENABLED = false;

/**
 * Lives, client side - ONE switch for both halves of WP-L5: watching (the LIVE card at the top of
 * the feed, the full-screen viewer) and broadcasting (the composer's "Live" chip, the pre-live and
 * broadcast screens) - `components/live/`, `lib/live/`.
 *
 * **ON FOR A DEV BUILD ONLY (2026-10-19)**, by the same test as {@link CALLS_ENABLED}: a build made
 * for `dev.canari-emse.fr` carries `VITE_DEPLOY_ENVIRONMENT=development`, a production build never
 * does, so a production binary asks `/api/lives` nothing and draws nothing. The server answers every
 * `/api/lives` route `404` on production anyway (its own `LIVE_ENABLED`, docs/wiki/services/lives.md)
 * - two locks, one per side. It is off there because **any member may broadcast** (decision D3) and
 * moderation - report a live, the staff cut, block (WP-L8) - is not built: a live nobody can cut is
 * not shipped.
 *
 * **Turns on for production when** WP-L8 is built, the store answers (WP-L9) are in, the viewer and
 * broadcaster readings of docs/wiki/device-verification.md (checks Y and LIVE-B1) have passed on the
 * Mi 9T and the iPhone 12, and the server's `LIVE_ENABLED` turns on in the same release
 * (docs/wiki/frontend/modules/live.md).
 */
export const LIVE_ENABLED = deployEnvironment() === 'development';
