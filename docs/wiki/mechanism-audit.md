# The mechanism audit - what is covered, by what, and what is covered by nothing

> Measured 2026-08-21 against `d4f71568`. This page is a JOIN, not a fourth copy of anything: the
> wiki says what each mechanism IS, the [campaign board](cross-client-testing.md) says what a check
> measured, the test trees say what a unit test pins. Nobody had ever read the three together, so
> nobody could say what the app has that nothing watches. That question is what this page answers.

**It is a coverage map, not a quality judgement.** "Covered" here means *something would fail if this
broke* - never *this works*. A domain with forty unit tests and no end-to-end row can still be broken
in production in a way every one of those tests passes through; that is exactly what the campaign was
built to catch, and it is why the two columns are kept apart instead of added together.

## How to re-measure it

Four commands, and they are the whole method. Anything below that is not reproducible from these is
marked as read off the source by hand.

```bash
bun tools/cross-client-harness/rows.mjs                  # board rows, verdicts, and the gaps
find frontend/src -name '*.test.ts' | wc -l               # frontend unit tests
find apps -name '*.spec.ts' -not -path '*/node_modules/*' # backend specs, by service
grep -rc '#\[test\]\|#\[tokio::test\]' apps/*/src libs/*/src frontend/src-tauri/src
```

## The instruments, and what each one can see

| Instrument | Size | What it can see | What it structurally cannot |
| --- | --- | --- | --- |
| The campaign | 201 rows, 19 phases | real clients, real server, real network, cross-device | anything outside messaging, communities and calls - by the user's own scoping |
| Frontend unit tests | 205 files | pure logic, reducers, formatters, parsers | rendering, routing, the network, two devices |
| Backend specs | 69 (Nest) | controllers and services against mocks | the wire, the browser, the phone |
| Rust tests | 39 fns across 4 crates | the gateway's routing, the SFU's state, the native bridges | everything above the crate |
| [device-verification](device-verification.md) | 16 hand steps (A-P) | native, push, biometrics, cold start | anything nobody performs this session |

## The map

Rows are ordered by what a failure costs, not by size.

| Domain | Board rows | Frontend tests | Backend specs | Verdict |
| --- | --- | --- | --- | --- |
| Messaging (DM, groups, MLS) | 90+ across MSG, TYPE, READ, MUT, FWD, GRP, DEL, HEAL, CORRUPT | 46 in `utils/chat` + 9 pipeline | 27 (chat-delivery) | **the covered case.** Everything else on this page is measured against it |
| Communities and channels (Graine) | 25 COMM | 8 in `utils/graine` | 12 (social/channels) | covered; 12 of the 25 verdicts owe a re-run (see the board) |
| Calls (WebRTC, CallKit, SFU) | 20 CALL | **0** | 10 Rust fns in call-service | **rows exist and NONE has ever run.** Paper coverage |
| Forms and submissions | **0** | **0** | **0** | **nothing watches this at all** - and it takes money and PII |
| Admin and platform config | **0** | **0** | 3 (core/platform) | `minClientVersion` lives here and can lock out every client |
| Moderation | **0** | **0** | **0** | nothing |
| Payments (Stripe Connect, shop) | **0** | 1 (`stripeFees`) | 7 (core/payment) | server-side only; no path is exercised end to end |
| Associations (members, permissions) | **0** | 1 (`cotisationTag`) | 8 (social/associations) | server-side only |
| Posts, feed, polls, comments | **0** | 2 (markdown, highlight) | 1 (social/posts) | one spec for the whole feed |
| Calendar and ICS | **0** | 2 (export) | **0** | export is pinned, nothing else is |
| Media (encrypted blobs) | 4 mentions, no row | 3 (layout, errors, touch) | **1** | the CEK path has one spec |
| Auth, PIN, sessions | 10 PIN rows, all `pending` | 2 + 3 session | 2 (core/auth) | device-verification covers the native half BY HAND |
| Backup and restore | **0** | 2 | n/a (client-side) | the refusal codes are pinned; the round trip is not |
| Follows | **0** | **0** | **0** | nothing |
| Minesweeper | **0** | **0** | **0** | nothing, and nothing is owed - it is a game |

## The findings, ranked

**1. Forms are the largest uncovered mechanism in the product, and they handle money.** A form takes
a submission, prices it (including the cotisant member price), and settles it in cash or through
Stripe. `apps/social-service/src/forms/` has no spec, `frontend/src/lib/**/forms` has no test, and no
board row names a form. Nothing in this repository would fail if a submission were priced wrong,
double-charged, or silently dropped. It is first on this list because it is the only uncovered domain
where a defect costs somebody money rather than a re-render.

Reading `forms-reminder.scheduler.ts` in full changed the SHAPE of that finding without softening it.
Its seven crons are not careless: the two reminder loops turn on durable flags (`notified5min`,
`notifiedOnOpen`) rather than a clock, they mark BEFORE sending with the trade-off written down in
the code ("worst case the notification is lost; acceptable vs spamming on every tick"), every catch
logs, and the five retention sweeps are bounded `DELETE`s with named constants. This is uncovered
code that somebody thought about - which is the *harder* case, not the easier one: there is no smell
to grep for, so nothing short of executing it will ever contradict it. The one-minute reminder tick
is also the only place in the product where a mechanism the campaign cannot see writes to a table
every sixty seconds. Whether that deserves a spec is a scoping call; that nothing would notice if it
stopped is a measurement.

**And it had a hole, found the moment anyone read it.** `POST /forms/submissions/:id/mark-paid`
let the submitter mark their own submission paid - tag granted, purchase record written, no Stripe
call in the path. It is deleted; the story is in `CHANGELOG.md` and the two rules it left are in
[durable-rules](durable-rules.md). Worth stating plainly, because it is the argument this whole page
exists to make: the defect was not subtle, not recent, and not hidden behind a race. It sat in a
public controller with its own JSDoc describing the behaviour ("Requires the submitter or a form
manager"), and it survived because no instrument in the repository was pointed at forms. A coverage
map does not find defects - but it says where to look, and the first place it pointed had one.

**2. Twenty CALL rows have never run.** The mechanism has real coverage in the SFU crate, and none
above it: no frontend test, and every board row `pending`. Ringing, CallKit, the missed-call system
message and the sibling-device path are all in the "written down, never measured" state - which the
campaign already knows is the state a defect ships in.

**3. Admin can lock every client out of the platform, and three specs stand between.**
`minClientVersion` is set by hand from `/admin/platform`, no deploy touches it, and raising it above
what the App Store has shipped locks out every iOS user it has not reached. That already happened
once (v0.14.0, see [legacy-compatibility](legacy-compatibility.md)). The screen that does it has no
test at any level.

**It now has a ceiling, and the ceiling is honest about what it cannot see.** A `minClientVersion`
above the server's own deployed version is refused - that catches the typo, and nothing more. The
defect that actually shipped was a raise to a version the App Store had not yet distributed, which
is at or below the deployed version and therefore still accepted. Said here because it is the second
thing this page keeps finding: a guard measured against the last incident is not a guard against the
next one, and the only real fix for that one is the shipping order in
[legacy-compatibility](legacy-compatibility.md), which is a procedure and not a check.

**4. Moderation and follows have nothing at all.** Neither is money, neither is loud, and both are
user-visible: a broken report queue or a follow that does not stick is a support ticket nobody can
reproduce.

**Moderation was READ on 2026-08-22 and its authorisation is correct** - recorded because a coverage
map that only ever reports holes teaches its reader that uncovered means broken. Every admin path
(`GET reports`, `PATCH reports/:id`, mute, unmute, `GET muted`) calls `assertModerator`, which
demands a global admin or the `MODERATE` flag in a BDE; `POST reports` is deliberately open to any
authenticated user, and takes `reporterId` from the `x-user-id` header rather than the body, so a
report cannot be filed in somebody else's name. Nothing here needs fixing. What it still lacks is
anything that would NOTICE if that stopped being true, which is the finding - not a defect.

**5. Media has one spec for the whole encrypted-blob path.** The client mints the CEK and the backend
sees opaque bytes, so a fault here is unrecoverable by design - there is no server-side copy to fall
back on. One spec is thin for a mechanism with no undo.

**Media's central invariant was CHECKED on 2026-08-22 and holds.** `apps/media-service/src` contains
no key material of any kind - no `cek`, no `key_b64`, no `iv`, no AES, no decrypt - and its two
mentions of encryption are both comments saying the server does not do it. The CEK travels inside the
MLS-encrypted `MediaMsg` and never reaches the service that stores the bytes. So the thin spec
coverage here is not sitting on top of a leak; the mechanism is as the architecture describes it. One
spec is still thin for a path with no undo, which is the finding.

## The findings so far, as a scoreboard

Stated because the value of this page is whether reading it CHANGES anything, and that is now
measurable rather than asserted.

| Ranked finding | What reading it produced |
| --- | --- |
| 1 Forms take money, nothing watches | **a P1 fixed** - the submitter could mark their own submission paid |
| 2 Twenty CALL rows never ran | unchanged; they are written and still unmeasured |
| 3 Admin can lock out every client | **a ceiling added**, and its limits written down |
| 4 Moderation and follows have nothing | **read, and correct** - authorisation sound, nothing to fix |
| 5 Media has one spec, no undo | **invariant checked, holds** - no key material server-side |

Two of five produced a code change, two produced a verified negative, one is unchanged. The negatives
matter as much as the fixes: a coverage map that only ever reports holes teaches its reader that
uncovered means broken, and three of these five were not.

## What this page deliberately does not say

- **It does not rank by likelihood.** Nothing here is a prediction about where a defect is; it is a
  statement about where one would go unseen. Those are different questions and only the second one is
  answerable from a coverage map.
- **It does not propose a scope.** Whether the campaign should grow past messaging is the user's call
  and has already been answered once: *"cross-client-testing soit une matrice parfaite de tout ce qui
  est possible de faire avec les messageries/communautes"*, plus calls. This page exists so that
  scoping decision is made against a measurement instead of an impression.
- **It does not restate a mechanism.** Every row points at the wiki page that owns the explanation.

## See also

- [cross-client-testing](cross-client-testing.md) - the board, and every verdict on it
- [cross-client-campaign](cross-client-campaign.md) - the ladder and what it is allowed to contain
- [testing-methodology](testing-methodology.md) - how a result earns belief
- [device-verification](device-verification.md) - the hand pass that covers the native half
