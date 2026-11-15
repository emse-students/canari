## P2 - picking a conversation suggestion in the iOS share sheet offers nothing in Canari

target: 1.7.0

**The defect (read twice, 2026-11-14, iPhone 12, TestFlight `1.6.12-alpha.2`):** picking one of Canari's conversation suggestions in a share sheet (Safari, a web page) dismisses the sheet, and Canari then offers no share - no picker, no banner. The route through the app row ("Canari", then the banner) works. The cause is not known: the extension's own lines never reached a store-build reading, so it could not be told whether the extension ran at all.

**What exists:** from the next release the share extension logs at notice level with the `[CanariShare]` prefix, and a first line says the extension was launched at all (`[CanariShare] share extension launched, intent=...`, so its absence means the system never started it), and its entry line names the path the sheet took: `[CanariShare] share extension opened with N item(s), intent=..., send_message_intent=..., suggestion=...`, plus the shape of an identifier it ignored. That line is what the cause is read from once a build carries it; the suggestion code is in `canari_Share/ShareViewController.swift` (`suggestedTarget`) and the donation in `ShareSuggestions.swift`.

**The fix:** not made yet - it follows the cause. Candidates in order of cheapness: the extension is not started for an intent suggestion (an `Info.plist` activation or `IntentsSupported` cause), it starts with no intent, or it receives an identifier not of the `c:` shape.
