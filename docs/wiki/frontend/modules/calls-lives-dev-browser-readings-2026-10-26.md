# Calls and lives on dev, read with browsers only - 2026-10-26: `BLOCKED` on accounts

**Verdict: no scenario was run.** Every calls and lives scenario needs two signed-in accounts that
share a conversation, and the rig has exactly four test accounts, every one of them held by a live
seat of the cross-client campaign replay running on the same estate at the time. Taking one would
mint a new device on an account the replay is measuring. Nothing was signed in, nothing was written
to the server.

## What was read (read-only)

| Fact | Source |
|---|---|
| Dev served `1.4.1-alpha.6`, build `dev.349f092`, `minClientVersion` `1.2.7` | `GET /api/version` |
| Dev's calls switch read `audio_video` and lives read `on`; `testers` is not a value the server has ([the kill switch](calls.md#the-servers-kill-switch-and-the-metered-turn-budget-b12-b7-2026-10-21)), so there is no tester list to be in: every signed-in dev account may call | `GET /api/version`, `calls.md` |
| The rig has four accounts (owner, peer, third, fourth); owner is held by W1, W3, W6 and the A1 phone, peer by W2, third by W4, fourth by W5 | `test-accounts.json` (keys and client lists only, no secret read), `names.example.mjs` |
| The rig's login reads its credential file itself and no credential is a command argument ([README](../../../../tools/cross-client-harness/README.md#setting-it-up)) | harness README |

## Why a fresh profile on an existing account is not free

- A new browser context is a NEW MLS device of that account. Its enrolment adds a leaf to every group
  the account is in, which is a commit the replay's seats must process and which `stale-devices.mjs`
  (run in the replay's preflight) reports as a device no seat holds, refusing the plan.
- Two contexts of different accounts that share a conversation need two accounts the replay is not
  using. There is none; the fixtures `campaign-g2` and the owner-peer DM belong to the replay.

## What is needed to run the matrix

Either of:

1. Two further dev test accounts, each signing in through the same service-account flow as the rig's
   (no second factor), with a PIN, and a direct conversation between them created through the product.
   They must be recorded in the campaign ledger as created for this reading so the replay's sweeps
   spare them.
2. A window in which the replay has stopped and the operator hands over two seats' accounts
   (for example the third and fourth, W4 and W5, whose DM is the natural pair).

Either way the run also needs Chrome started with `--use-fake-device-for-media-stream
--use-fake-ui-for-media-stream` on a profile directory of its own, and read-only access to the dev
call-service log for each scenario's minute (the route is in the private operations notes).

## The matrix, ready to run (A: calls lot 1; B: lives)

Verdicts are all `BLOCKED` until the accounts exist.

| # | Scenario | Evidence to take |
|---|---|---|
| A1 | place, ring, accept | `[Call] selected path ... relayed=` on both consoles, `[CALL_REPORT]` lines, `RTCPeerConnection.getStats()` inbound-rtp audio `bytesReceived > 0` on BOTH sides |
| A2 | mute, unmute | sender track `enabled`, the outbound level in `[CALL_REPORT]`, the peer's inbound level |
| A3 | hang up from each side (two runs) | `PeerLeft` on the other side, no missed-call line, room released |
| A4 | decline | ring stops on both, one call line in the conversation |
| A5 | caller cancels before answer | callee's ring stops, a missed-call line |
| A6 | callee offline | caller reaches the ring window and ends as missed; no `PeerReady` |
| A7 | second call attempt while in call | refused with a typed reason, the first call untouched |
| A8 | reload mid-call | the peer's `PeerLeft` or resumed `PeerReady`, and what the reloaded tab shows |
| B1 | what starts a live and where | [live](live.md), [lives service](../../services/lives.md) |
| B2 | start, viewer joins, announcement reaches a member, end | the announcement and the viewer path |

Lives caveat, said now so it is not discovered mid-run: the broadcaster reads a real camera at
1280x720 plus a microphone (`liveDevice.ts`) and records it with `MediaRecorder` into fMP4 segments.
Chrome's fake device yields a synthetic test pattern and a beep, which the recorder accepts, so a
browser broadcast is expected to run; what a fake device cannot give is anything about real lens
selection, the background-camera drop on the phones and the iPhone's recorder, all owed to
[LIVE-B1 and check Y](../../device-verification.md). The live surfaces are gated by `LIVE_ENABLED`
(dev builds only) and by the server's lives switch, which read `on` on dev today.

## See also

[calls](calls.md), [live](live.md), [device readings 2026-10-18](../../device-readings-calls-live-2026-10-18.md),
[testing methodology](../../testing-methodology.md).
