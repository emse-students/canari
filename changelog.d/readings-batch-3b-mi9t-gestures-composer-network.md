### Changed - readings batch 3b: the Mi 9T gesture, composer and slow-link readings

Eleven owed readings leave the plan on the Mi 9T (`1.6.12`, dev): the scroll after an edge swipe (6 of 6
strokes move, immediate or after 3 s or from the edge strip; `adb input swipe`, the shell cannot write the
touch device), a DM read receipt surviving a kill 0.8 s after opening it (the peer got one `[READ]` for two
messages, 0.3 s after the kill), the new-discussion panel (it searches from two letters, `UserAutocomplete`;
one letter keeps the recents), the two media of the "format non supporte" conversation (both play, no refusal
line), the connection ring through a +800 ms / 250 kbps proxy (never grey, a circle in light and dark, names on
the first frame, the live region says offline and "Connexion retablie", a feed video keeps its frame across a
tab round trip), `[QUEUE] delivery arrived twice` (0 lines in 3 cold starts cut by a Wi-Fi loss), the socket
race on the bench Wi-Fi (connected over IPv6 in 28 ms, the WARN only while Wi-Fi was off), and the per-frame
record of a 90 px keyboard (no frame 12 px low, [chat](docs/wiki/frontend/modules/chat.md)).
Closed without a phone: the fingerprint prompt (the owner closed it; the bench holds no finger, keystore
unlock decision at 2.61 s and 2.93 s, MLS ready 3.99 s and 4.27 s), the biometric cadence (same owner decision
about the finger), the captive-portal send (a 2xx non-JSON body cannot be forged inside TLS; pinned by
`QueuedSendAnswerTest.aNonJson2xxIsACaptivePortalAndIsKept`) and the blackholed IPv6 (pinned by
`happy_eyeballs::a_blackholed_ipv6_loses_to_ipv4_after_one_delay`). A defect stays open: on `/communities` the
left-edge swipe inside the exclusion band changes no section ([readings owed](docs/wiki/plan.md#readings-owed)).
