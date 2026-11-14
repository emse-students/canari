## Reading owed - the `event_pending_coorganiser` push on both phones

target: 1.7.0

WP-Q2 added a seventh social content key (a partner joined a validated event, which went back to the queue): Android `values` and `values-en`, the iOS app and NSE `Localizable.strings` (fr, en), the Android service, the NSE and `canari_push.mm`. The server-side parity test passes; no device has received one. The bodies are audience-neutral ("une association a accepté de co-organiser"), since the same key now reaches the organiser, the partners and the validators. Owed: one acceptance on a validated event on a bench phone and an iPhone, reading the pushed title and body in both languages ([profiles-and-access](../profiles-and-access.md#wp-q2-an-acceptance-on-a-validated-event-reopens-it-2026-11-03)).
