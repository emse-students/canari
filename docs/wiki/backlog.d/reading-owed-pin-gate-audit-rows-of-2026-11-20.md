## Reading owed - the PIN gate's audit rows of 2026-11-20 (deadline, 429, confirmation, removed device)

target: 1.7.3

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

Built ([auth](../frontend/modules/auth.md#pin-and-device-key)): every PIN request lives under the app's
request deadline and ends as "unreachable"; a 429 reads "Trop d'essais. Reessayez a HH:MM."; a first
setup asks "Confirmez votre PIN"; an unanswered `pin-status` shows the gate with no keypad and
"Reessayer"; a removed device shows "Cet appareil a ete retire de votre compte" with no keypad.

The reading that closes it, on a bench phone and in a browser on dev: (1) a new test account's first
unlock asks the PIN twice, a differing second entry is refused and asked again; (2) with the link
cut after the keypad is drawn (airplane mode on the phone, offline in DevTools), "Deverrouiller" ends in
the unreachable text within the deadline, and works again once back; (3) a device removed from another
device, then typing the PIN at its gate, shows the removed state and "Se deconnecter" leads to the
sign-in page; (4) the sign-in page shows "Se connecter avec un mot de passe"; (5) a test account
whose first setup was abandoned after the keypad appeared (app killed) is asked to CHOOSE a PIN, twice,
at the next launch - never to unlock - and the chat-delivery log shows no `legacy client (no intent)`
line for it.

**2026-11-20, [S18](../device-verification.md#the-readings-of-2026-11-20-s18-172-alpha3-notice-previews-launcher-shortcuts-the-capture-line-live-screens-and-the-backup-domains) (`1.7.2-alpha.3`): NOT TAKEN.** The unreachable and 429 states cannot be induced on the bench phones; the rows stay owed to a browser on dev with DevTools offline.

**2026-11-22, web rig (`1.7.3-alpha.5`, dev): rows 2 and 4 READ, PASS.** Offline in DevTools after the keypad was drawn, "Déverrouiller" ended in the unreachable text in 1.1 s and the same PIN unlocked once back online; the sign-in page shows "Se connecter avec un mot de passe". The 429 text, rows 1, 3 and 5 stay owed: they need a new test account, a device removed from another device, and an abandoned first setup.

**2026-11-22, web sitting on `1.7.3-alpha.6` (dev, browser, test account): rows 2 and 4 PASS, row 3 FAIL, rows 1 and 5 NOT TAKEN.** (2) Offline after the keypad: "Serveur injoignable ... Reessayez." within 6 s (an instant offline does not exercise the deadline itself). (4) The sign-in page offers "Se connecter avec un mot de passe". (3) A device removed from another device's panel **while it sat at the PIN gate**: typing the PIN shows the ordinary keypad with "Serveur injoignable : votre PIN n'a pas pu etre verifie", NOT "Cet appareil a ete retire de votre compte". The network shows `GET /api/mls/security/pin-salt/<user>` answering **401** twice: the removed state is only reached after the PIN is verified, which a removed device's dead session never gets to, so a 401 (an answer) is worded as unreachable. An UNLOCKED device removed live goes to the sign-in page at once; "Se deconnecter" works from the gate. Fix to name: a 401 on the gate's `pin-salt` or `pin-check` is the removed or signed-out state, not unreachable. (1) and (5) need an account with no PIN: every test account has one.
