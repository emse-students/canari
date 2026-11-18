## Reading owed - a live viewer sent to the background mid-request retries instead of stopping (iPhone)

target: 1.7.0

**Built:** the lives client read a manifest's body with `res.json()`, so a body lost after the head
(iOS suspends the app mid-request, the stream dies with WebKit's bare `TypeError: Load failed`) was
no transport failure and the viewer stopped on "Live indisponible". `liveJson` (`src/lib/live/api.ts`)
now reads through `readApiJson`, the one reader that types a lost body as `AnswerBodyLostError` (a
transport failure), so `liveFailureOutcome` retries and the viewer learns the live's real state
(`ended`). Found on `1.7.0-alpha.12`, S6
([readings](../device-verification.md#the-phone-and-web-readings-of-2026-11-18-s6-170-alpha12-live-moderations-last-halves-the-reel-card-overlays-the-birthday-morning)).

**The reading that closes it:** on the iPhone, on the next pre-release, open a live, send the app home
for a minute, come back: the viewer reconnects or shows the live as ended, never "Live indisponible"
for a live that ended normally. Delete the entry once read.
