## P3 - the iPhone sign-in helper misses the terms page's button when it is below the fold

target: 1.8.0

**Seen** on `1.7.1-alpha.3`, iPhone 12, the first live run of the `terms` stage of
`signInThroughSheet` (`tools/cross-client-harness/phone-ios.mjs`)
([S9](../device-verification.md#the-phone-readings-of-2026-11-19-s9-171-alpha3)). `findTermsBox`
found and ticked the checkbox - its first proof against the live page - and the helper then threw
`the terms page shows no submit button after the tick`: "Continue" was below the fold of the sheet,
and WDA's visible tree does not list an element off screen. `TERMS_SUBMIT_LABELS` does name
`Continue`; the lookup, not the label list, is what misses. A hand scroll and a tap finished the
sign-in.

**The fix:** after the tick, scroll the sheet (a swipe up in the web view) until a submit label
appears, bounded by the page reporting no further scroll rather than by a count, and pin it in
`archive/ios-observables-selftest.mjs` with a fake sheet whose button starts off screen.

**Closed when** an unattended `signInThroughSheet` of an account that has not accepted the current
terms ends signed in, with no hand on the phone.
