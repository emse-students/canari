# The harness tidy, and the campaign that follows it

**THIS FILE IS A WORK LIST AND IS DELETED WHEN IT IS EMPTY.** Its rules go to
[durable-rules](durable-rules.md), its stories to `CHANGELOG.md`, its verdicts to
[cross-client-testing](cross-client-testing.md). Linked from `CLAUDE.md`'s queue while it lives.

**Why it exists** (user, 2026-09-04): *"Plusieurs fois, tu as recodé des choses qui existaient deja
parce que le script n'avait pas ete trouve"*, and *"Je veux que tu tiennes une todo list tres precise
pour ne pas halluciner et devier"*. The duplication is not carelessness, it is a MISSING INDEX, and
the measurement below is what that costs.

**The standing bar** (user, same day): ***everything must be `PASS`, never `PASS-DIRTY`.*** A row
that passes while its logs carry something unexplained is not done - the noise is either expected AND
necessary, or it is the visible end of a defect. Same rule as `CLAUDE.md`'s NOISE line, applied to a
verdict.

**Severity discipline** (user, same day): **a P1 found on the way is fixed IMMEDIATELY**, in the
session that found it. P2/P3 go to [backlog](backlog.md) and are not fixed inline - they would
otherwise turn one measurement into an unbounded session.

---

## A. The index, and why it is the root cause

**MEASURED 2026-09-04** against `README.md`, over all 155 scripts then in the tree:

| what the README said | count |
|---|---|
| distinct scripts it names | 88 of 155 |
| root atoms it names NOWHERE - `arm.mjs`, `names.example.mjs`, `overlay-probe.mjs`, `rows.mjs` | **4** |
| archived scripts it names nowhere | **69** |
| references pointing at a root the files had just left | **45** |
| names it gives for scripts that exist nowhere | **6, and these are FINE** - the README says in as many words that they were probes which answered their question and were removed, and git confirms none was ever committed. I called them phantoms before checking; that was wrong. |

An index consulted, believed, and two-thirds incomplete does not merely fail to help - it sends the
reader to write the thing again, which is the reported symptom.

- [x] **A1 - DONE.** `## The files` is now the PROSE the generated list cannot carry (why files are
      grouped as they are), with a pointer at the top saying so, and a warning that a name without a
      directory may live in `archive/`.
- [x] **A2 - DONE, and it is the half that lasts.** `inventory.mjs` derives `INVENTORY.md` from the
      leading docblock of every script - 154 of 155 already had one, and the 155th had a single-line
      docblock my first matcher was too narrow to see. `bun inventory.mjs --check` is the FIRST line
      of `make test-harness`, so a script added, moved, renamed, or left undocumented fails the gate.
      **Proven to fail** on each of those three cases and to pass when clean; a gate never seen to
      fail is not a gate.
- [ ] **A3. Check the split is right.** The atom/row boundary came from an import-closure over a root
      set I chose. Some of the 42 may be rows; some of the 114 may hold a gesture worth promoting.
      Re-read the boundary deliberately rather than trusting the closure that drew it.

### What CI caught that local gates did not, 2026-09-04

Three jobs failed on PR #380 and each was a real defect, not a flake:

- **`Error 127` on `make test-harness`** - the node -> bun conversion moved the recipe to `bun`, and
  that CI job set up node ALONE. `Error 127` is "command not found" and names nothing, which is why
  it is written down here.
- **`phone.mjs` carried a RAW NUL BYTE** (a `/proc/<pid>/cmdline` separator written literally into a
  regex), so ripgrep classified the whole file as binary and reported NO matches in it. There is a
  gate for exactly this. **I had already met the symptom and worked around it with `grep -a` instead
  of asking why** - the workaround is the defect.
- **`tauriCapabilities.test.ts` read `capabilities/development.json` by name**, so renaming it threw
  ENOENT. It now reads the DIRECTORY, and carries three new guards that fail if the local scope is
  ever put back into the base config, if the capability subset is unnamed, or if a scope entry
  forgets its port wildcard. Each was proven to fail before being believed.

## B. The atomic commands that do not exist yet

Libraries stay as they are (user: *"Les librairies ce n'est pas trop mal non plus"*) - the gap is
that some gestures have no command over them. `--device` decides the platform, as `isPhone` already
does in `login.mjs`.

- [x] **B1 - DONE as an atom, BLOCKED as a fixture.** `pin.mjs` takes `--android`, binds the phone
      with `useDevice` and arms it with `ensure`, exactly as `login.mjs` does. Running it on A1 ends
      in 2.9 s on a FACT and reports it: *"Votre PIN a ete change sur un autre appareil. Recuperez vos
      messages avec votre ancien PIN."* - the product refusing, exit 1. It used to spend 25 s and
      throw `until() timed out`, because it waited for the single word "incorrect". **What is left is
      not code:** the PIN in `test-accounts.json` was not this estate's PIN for that account - since
      resolved, see C2, and `bun pin.mjs --android` now exits 0 with the gate gone. The missing
      `role="alert"` that forced the atom to key on a Tailwind colour class is a P2 in
      [backlog](backlog.md).
- [x] **B2 - DONE, and it took three attempts to make its post-condition honest.** `send.mjs` wraps
      `send()` from `chat.mjs` and adds only argument resolution and a post-condition. The first one
      was the sender's own pane - the app renders optimistically, so it PASSED on a message the server
      had refused three times. The second read the response in the same tick the request was sent, so
      the status was `pending` and it passed again. It now waits for the answer and exits 1 on a 4xx,
      printing the product's own refusal. **It found the P1 above the moment it was honest.**
- [x] **B3 - DONE.** `recv.mjs` wraps `awaitMessage()`, which already carries the hard part: a miss
      reports the PANE STATE, so it distinguishes absent from late from below-the-render-window.
      `--absent` inverts it for the cases that assert a message does NOT arrive. It is a separate
      command from `send.mjs` deliberately: only a receiver can prove delivery, and one command doing
      both could not fail honestly.
- [ ] **B4. `logs.mjs --device A1 [--server]`** - today this is three libraries (`watch.mjs` for the
      client, `phone.mjs` for logcat, `srvlog.mjs` for the estate) and no single command.
- [ ] **B5. Uniform flags** on `shot.mjs` (positional argv today), `unlock.mjs`, `reload.mjs`.
      `device.mjs` now owns `--device`/`--android`/`--port`/`--account` and the phone-arming ladder;
      `login.mjs` and `pin.mjs` both use it. **It exists because I wrote the second copy an hour after
      the first** - the duplication the user reported, happening live - and a third was about to
      land in `send.mjs`.

## C. Blocked on the user

- [x] **C2 - RESOLVED 2026-09-04, and the cause is a process defect worth keeping.** The PIN in
      `test-accounts.json` was refused on A1 with *"Votre PIN a ete change sur un autre appareil"*.
      **Measured rather than guessed**: the owner's `pin_verifier` row - `f7a9bb80...`, the same user
      id that appeared in the scope error earlier that day - carried `registeredAt = 2026-09-04
      08:33`, while the file records a rotation of 2026-09-03. **Someone re-registered the PIN that
      morning and never wrote the new value back to the one file that records it.** Resolved through
      the PRODUCT's own reset path on A1 - authorised, the accounts being throwaway, and no venue
      fixtures existed so the *"efface definitivement l'historique"* warning cost nothing - then
      re-created from the file, which is true again as of 15:32. `bun pin.mjs --android` exits 0 with
      the gate gone, and **A1 is a usable device for the first time this campaign.**

      **The rule this leaves:** a PIN changed on ANY client is written back to `test-accounts.json`
      the same minute. It is the same failure as a fact living only in a chat history, and it cost a
      session. Two stale facts in that file were corrected at the same time - `_target` still named
      `localhost:1420`, the dev server the campaign moved OFF on 2026-09-03.

- [x] **C3 - RESOLVED 2026-09-04 BY FIXING THE PRODUCT, NOT THE FIXTURE, AND MY FIRST ANSWER WAS
      WRONG.** I raised it, checked W1, saw session `true`, no gate and an `mls_device_id` present,
      and closed it as "the risk did not hold". **I measured the absence of a gate, not the validity
      of the key.** The user pushed back - *"le PIN n'est plus censé être bon je crois"* - and they
      were right: W1 could not send at all, every `POST /api/mls/send` refused 403, and a full page
      reload did not lift it.

      **It was not a fixture problem.** The DB said what the client could not: W1's
      `dm_device_group_memberships` row sat `pending` from 15:34:52, two minutes after the PIN reset,
      while the peer's was `active` from 08:36. Nine messages were queued at attempt 18-40. **No
      re-mint was owed - a repair was**, and the reason nobody had written one is that all three
      recovery mechanisms test for a LOCAL absence and this device held its tree. Fixed in the
      product (`recoverRosterDisagreement`), proven end to end on this very client: refusal at
      18:28:34, rejoined by external commit and the held message sent at 18:28:37. Story in
      `CHANGELOG.md`, rules in [durable-rules](durable-rules.md), residual half in
      [backlog](backlog.md).

      **W1, W2 and W3 are all `active` in `2bd5add9` as of 18:28**, and a full round trip was then
      measured with the new atoms - `send.mjs --device W1` accepted 201, `recv.mjs --device W2`
      saw it, and the reverse direction the same - so the campaign's blocker here is gone and D2
      owes no re-mint. `recv.mjs` earned its keep in the same run: its first miss reported
      `hasPane:false` rather than "absent", which is the precondition the caller owed (W2 had just
      reloaded and had nothing open) and not a delivery failure - the message was already in the
      sidebar with an unread badge. **The rule this leaves:** *"no gate"* is not *"healthy"*, and the
      only thing that distinguishes them is trying to send - which is now also the only thing that
      REPAIRS them, and is why the silent-reader half is a P2 rather than closed.

- [ ] **C1. `ACCOUNT_OF.A2`.** The second phone (Pixel 6a) is bound and addressable on port 9335, but
      no account is assigned and guessing one would be an identity invented by a tool. Peer, or a
      third account? One line in the out-of-tree `names.mjs` once decided.

## D. The campaign, from zero

Only after A and B. The order is [cross-client-campaign-resume](cross-client-campaign-resume.md)
section 5 and is not restated here.

- [ ] **D1. The two Chrome profiles** - `chrome-w1`, `chrome-w2`. Losing one costs a DEVICE.
- [ ] **D2. The venue fixtures** in the resume page's order. A row run before they exist reports on
      whatever conversation was on screen.
- [ ] **D3. Rung 1**, then upward - reusing and improving the archived rows rather than rewriting
      them, which is the whole point of keeping them.

## E. Standing, for every item above

- [ ] **E1. Any P1 found is fixed in the same session**, with its story in `CHANGELOG.md` and its
      rule in [durable-rules](durable-rules.md).
- [ ] **E2. Any P2/P3 found goes to [backlog](backlog.md)** and is NOT fixed inline.
- [ ] **E3. Read the logs on every pass** (user, 2026-08-28), the reconciliations especially.
      `PASS-DIRTY` is not a passing verdict.
