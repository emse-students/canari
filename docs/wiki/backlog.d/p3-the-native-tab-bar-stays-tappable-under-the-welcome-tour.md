## P3 - on iOS the native tab bar stays tappable under the welcome tour's backdrop (observed 2026-11-03, `1.6.3-alpha.7`)

On the iPhone 12 a tap on the chat tab while the tour was on its last step left the tour and opened
`/chat`: the bar is drawn above the WebView, so the backdrop does not cover it. Whether that is the
intended exit (the tour is then put back unseen or marked seen) is not answered by the reading: the
`help_seen` row was not inspected. Owed: the same tap on the six-step tour (an account with tab
steps, where the bar's band is the halo) and a look at the row afterwards. Mechanism and the band
regions: [guided-help](../frontend/guided-help.md). Reading: [device-verification](../device-verification.md).
