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
 * Calling as the STORE BINARIES carry it: in-app calls ({@link CALLS_ENABLED}) and the call kept
 * alive in the background - the iOS `audio` background mode, the Android microphone foreground
 * service (`src/calls/`, merged by `build.gradle.kts`) and the microphone purpose strings that name
 * calls. `callsCompiled.test.ts` and `androidCallServiceManifest.test.ts` assert that each of those
 * agrees with this constant.
 *
 * **NOT THE NATIVE RING (since 2026-10-21, B2').** Ringing a phone whose app is closed or in the
 * background - Android CallStyle + full-screen intent, iOS PushKit/CallKit - is
 * {@link CALLS_NATIVE_RING_COMPILED}, a fact of its own: the owner decided on 2026-10-21 that the
 * first production calls (audio 1:1) ship WITHOUT it, so the two must be able to move apart.
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
 * (`docs/wiki/cross-client-testing.md`) and the blockers of the audio enablement are lifted
 * (`docs/wiki/frontend/modules/calls.md`). Its flip moves the `audio` mode, the microphone service
 * and the purpose strings in the same commit; the native ring does NOT move with it.
 */
export const CALLS_COMPILED = false;

/**
 * The NATIVE RING as the store binaries carry it: a call rings a phone whose app is closed or in
 * the background - Android's CallStyle notification and its full-screen intent, iOS PushKit and
 * CallKit. Mirrored by `CALLS_ENABLED` in `CanariFirebaseMessagingService.kt` and
 * `kCanariCallsEnabled` in `canari_push.mm` (both run when no webview exists and cannot read this
 * file), and declared to the stores by the iOS `voip` background mode and Android's
 * `USE_FULL_SCREEN_INTENT`; `callsCompiled.test.ts` asserts all four agree with this constant, and
 * that it is never on while {@link CALLS_COMPILED} is off (a ring the binary could not answer).
 *
 * **OFF, and it stays off when calls first ship** (owner, 2026-10-21: the first production calls
 * ring an app that is OPEN, over the chat socket, and nothing else). No iPhone has ever registered a
 * PushKit token, no CallKit ring has ever been delivered, the Android ring still carries the
 * caller's name in its payload, and App Review refused `voip` under 2.5.4 on 2026-08-31 for a
 * feature it could not locate.
 *
 * **Turns on when** WP-C5 (the Android ring rebuilt: names from the phone's copy, the full-screen
 * permission on Android 14+, the call permission honoured natively) and WP-C6 (iOS: a VoIP push
 * always reports a CallKit call, the answer path behind the PIN) are built and their K6/K7/K8
 * readings pass on both bench phones - the four switches above in ONE commit
 * (`docs/wiki/frontend/modules/calls.md`).
 */
export const CALLS_NATIVE_RING_COMPILED = false;

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
 * Video in a call: the video-call button and the camera controls inside a call.
 *
 * **ON FOR A DEV BUILD ONLY, AND IT DOES NOT FOLLOW {@link CALLS_COMPILED}.** Since 2026-10-20 (lot
 * 2) the E2E transform frames video per codec - VP8's payload header in clear and bound as AES-GCM
 * additional data, the rest encrypted - and every video m-line is held to VP8, the codec it frames
 * (`utils/callVideoFrame.ts`, `utils/callVideo.ts`). H.264, which WebKit would otherwise offer
 * first, cannot be packetised once encrypted whole and is never negotiated. Measured Chrome to
 * Chrome in the rig (docs/wiki/frontend/modules/calls.md, "Video, measured").
 *
 * **Why it is not `CALLS_ENABLED`** (the owner, 2026-10-21): the first public build with calls is
 * AUDIO 1:1 ONLY; video follows later. Written as `CALLS_ENABLED` it would have gone to production
 * with the flip of {@link CALLS_COMPILED}, unread on any phone.
 *
 * **Turns on for production when** the video readings of the calls page (both bench phones, both
 * directions, camera on/off and switch) have passed and the owner opens video - its own commit,
 * after the audio stable.
 */
export const CALLS_VIDEO_ENABLED = deployEnvironment() === 'development';

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
