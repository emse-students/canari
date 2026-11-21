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
