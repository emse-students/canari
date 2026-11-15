## P2 - picking a conversation suggested in the iOS share sheet offers nothing in Canari

target: 1.7.0

**Seen 2026-11-15 on the iPhone 12** (TestFlight `1.6.12-alpha.2`, dev, Safari as the source, the share sheet's suggestion row showing the Canari badge). Five attempts in a row, on a 404 page and on the sign-in page: tapping a suggested conversation dismisses the sheet and **nothing follows**. No extension card ("C'est pret...") and no "Choisissez la conversation" banner on screens taken 1, 2.5 and 3.5 seconds after the tap, and no way into Canari's "Envoyer a..." picker. The earlier readings of 2026-11-14 are split (two saw nothing, one saw the card and banner after launching Canari by hand), so the likely truth is that the suggestion path does not hand the item over reliably, while the "Plus" > Canari path does.

**To do:** log the extension's two entry points (a suggestion pick, and the app's own row) to the shared container with the same line, reproduce on the device with the syslog open, and make a suggestion pick take the same import path as the app's row. Pin the intent-to-item mapping in a unit test of the extension's input handling.

Screenshots with real names stay in the private harness folder.
