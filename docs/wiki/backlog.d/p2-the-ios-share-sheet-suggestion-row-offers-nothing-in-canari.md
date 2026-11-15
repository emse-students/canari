## P2 - picking a conversation suggestion in the iOS share sheet offers nothing in Canari

target: 1.7.0

**The defect (read twice, 2026-11-14, iPhone 12, TestFlight `1.6.12-alpha.2`):** picking one of Canari's conversation suggestions in a share sheet (Safari, a web page) dismisses the sheet, and Canari then offers no share - no picker, no banner. The route through the app row ("Canari", then the banner) works. The cause is not known: the extension's own lines never reached a store-build reading, so it could not be told whether the extension ran at all.

**What exists:** from the next release the share extension logs at notice level with the `[CanariShare]` prefix, and a first line says the extension was launched at all (`[CanariShare] share extension launched, intent=...`, so its absence means the system never started it), and its entry line names the path the sheet took: `[CanariShare] share extension opened with N item(s), intent=..., send_message_intent=..., suggestion=...`, plus the shape of an identifier it ignored. That line is what the cause is read from once a build carries it; the suggestion code is in `canari_Share/ShareViewController.swift` (`suggestedTarget`) and the donation in `ShareSuggestions.swift`.

**Reproduced 2026-11-15 (iPhone 12, `1.6.12-alpha.2`, dev, Safari as the source, the suggestion row showing the Canari badge):** five picks in a row, on a 404 page and on the sign-in page. Each dismissed the sheet and nothing followed: no extension card and no "Choisissez la conversation" banner on screens taken 1, 2.5 and 3.5 seconds after the tap, and no way into Canari's "Envoyer a..." picker. The readings of 2026-11-14 are split (two saw nothing, one saw the card and banner after launching Canari by hand), so the suggestion path does not hand the item over reliably, while the "Plus" > Canari path does. Screenshots with real names stay in the private harness folder.

**To do:** read the cause from the `[CanariShare]` lines on the first build carrying #3535 first (`bun x pymobiledevice3 syslog live` or the iOS bench's syslog, filtered on `CanariShare`), then fix what they name. Candidates in order of cheapness are below.

**The fix:** not made yet - it follows the cause. Candidates in order of cheapness: the extension is not started for an intent suggestion (an `Info.plist` activation or `IntentsSupported` cause), it starts with no intent, or it receives an identifier not of the `c:` shape.
