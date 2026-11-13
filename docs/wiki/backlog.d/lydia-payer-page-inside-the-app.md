## P3 - Lydia's payer page inside the app, not in the system browser (owner's question, 2026-11-13)

The owner asked whether a payment could stay inside Canari. Today "Payer" hands Lydia's payer page to the system browser (`navigateExternal`, the opener plugin), and the payer comes back by hand ([forms](../frontend/modules/forms.md#the-native-payers-return-read-on-resume-and-an-https-return-on-android-2026-11-13)).

- **An app switch cannot be removed for a Lydia-account payment**: Lydia's page asks the payer to confirm in a Lydia-compatible app (Lydia / Sumeria), so the payer leaves Canari for that app whatever shows the page.
- **What an in-app browser would give**: Android Custom Tabs / iOS `SFSafariViewController` keep Lydia's page, and its card option, on top of Canari, with a native close that lands back on the form - the card payment would then never leave the app, and the return URL would come back to the app that opened the tab.
- **What it would take**: a Tauri plugin opening a Custom Tab / `SFSafariViewController` (none is used today; a community plugin or a small native one of ours, Kotlin + Swift), a call site in `navigateExternal`'s place for the three checkouts (form, public form, shop), and a phone reading on both platforms of a card payment and a Lydia-app payment through it. The read-on-resume of 2026-11-13 stays: it is what tells the payer where the payment stands whatever brought them back.
- **Not built. The decision is the owner's, after the resume fix ships and is read on a phone.**
