## Reading owed - sharing into Canari on iOS

target: 1.7.0

**What is built:** sharing into Canari on iOS (S4) and the share suggestions on both systems (S5); Android S1-S3, S5 and S6 passed on the Mi 9T on 2026-10-28 ([readings](../device-readings-2026-10.md#2026-10-28---sharing-on-the-mi-9t-151-rig-builds))

**The reading that closes it:** the iPhone 12 rows of [sharing, Owed](../frontend/sharing.md#owed) (S4, then S5); on the Mi 9T, what is left in the same list (S5 picking, toggle off, sign-out, second account; a PDF and a video shared in; a second share while the first waits)

**Read 2026-11-14 on the iPhone 12, TestFlight `1.6.12-alpha.2`, dev estate** ([readings](../device-verification.md#the-iphone-12-batch-6-readings-of-2026-11-14)): iPhone half, partly read: Safari "Share" > Canari (from "Plus") shows the extension card "C'est pret. Touchez la notification de Canari pour choisir la conversation." and the banner "Choisissez la conversation"; a tap on the banner opens Canari on the "Envoyer a..." picker (warm, nothing sent). **S5, first step `PASS`**: the share sheet's suggestion row lists four Canari conversations with the Canari badge (avatars drawn as grey discs). Picking a suggestion dismissed the sheet and nothing was offered in Canari (no `CanariShare` line in the syslog); not read further. Left: Photos, Notes, Files, cold with the PIN gate, a share while the app is on screen, a second share while the first waits, a share then a sign-out, the logs of the extension. The Mi 9T leftovers are not part of this reading.
