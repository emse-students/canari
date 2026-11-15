## Reading owed - the `event_pending_coorganiser` push on both phones

target: 1.7.0

WP-Q2 added a seventh social content key (a partner joined a validated event, which went back to the queue): Android `values` and `values-en`, the iOS app and NSE `Localizable.strings` (fr, en), the Android service, the NSE and `canari_push.mm`. The server-side parity test passes; no device has received one. The bodies are audience-neutral ("une association a accepté de co-organiser"), since the same key now reaches the organiser, the partners and the validators. Owed: one acceptance on a validated event on a bench phone and an iPhone, reading the pushed title and body in both languages ([profiles-and-access](../profiles-and-access.md#wp-q2-an-acceptance-on-a-validated-event-reopens-it-2026-11-03)).

**Triage 2026-11-14: Mi 9T about 25 min (staging the validated event with a partner acceptance on dev, once), iPhone about 10 min on the same acceptance, both languages.**

**iPhone 12 half, READ 2026-11-15 on dev (TestFlight `1.6.12-alpha.2`, build `100601202`, app killed), both languages:** delta proposed "Banc coorg 1115" for "Club randonnee" (gamma, the platform admin, was told "Event to review" and validated it from that push), then named "Club d'Echecs Fictif" as co-organiser and accepted for it (`[COORG] 9523a7e6 was validated: back to pending, a partner (f1ddbfe2) joined it`). Gamma, a validator, received in English "Event needs approval again" / "“Banc coorg 1115” needs approval again: an association accepted to co-organise", and after a second validation and a second acceptance with the app in French "Événement à revalider" / "« Banc coorg 1115 » doit être revalidé : une association a accepté de co-organiser". The event was deleted afterwards. **Left: the Mi 9T half.**
