/**
 * The exact bodies the native push code renders when it could NOT decrypt - one list for BOTH phones.
 *
 * A NOTIFICATION THAT ARRIVED IS NOT A NOTIFICATION THAT WORKED, and no check here could tell the
 * two apart: NOTIF-4/9/10 all asked `full.includes(marker)`, so a shade full of "Nouveau message de
 * X" simply made the marker absent, which reads as "the notification has not arrived yet" and then
 * as a timeout - a completely different diagnosis from "background MLS decryption failed". The user
 * saw the generic form on the phone during a run this file called `PASS`.
 *
 * Kept as literals rather than a loose pattern because they are literals in the Kotlin
 * (`buildFallbackText`, `buildChannelFallbackText`) and in `push-payload.ts` for the APNs side. A
 * pattern would drift from them silently; a literal that stops matching is a rename, which is a
 * change to go and look at.
 *
 * ITS OWN MODULE SINCE THE iPHONE ADAPTER (2026-10-01): `phone.mjs` and `phone-ios.mjs` both judge a
 * notification by it, and `phone.mjs` imports the gitignored `names.mjs`, so a list living there could
 * not be reached by the gated self-test of the other platform.
 */
export const GENERIC_BODIES = [/^Nouveau message de /, /^Nouveau message dans #/, /^Vous avez re.u un message chiffr/, /^Nouveau message$/];
