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
- [x] **A3 - DONE, AND THE BOUNDARY WAS WRONG IN THE DIRECTION THAT COSTS.** I re-read it by turning
      the contract's own words into a predicate instead of re-reading prose: a row WRITES A VERDICT,
      and it can only do that through `results.mjs`, so the question is asked of the import list.

      **The root was almost right; `archive/` was announced as something 52 of its 114 files are
      not.** Measured: 43 atoms + 1 primitive at the root, and in `archive/` **62 rows, 13
      self-tests and 39 gestures, libraries and runners**. `addmember.mjs` opens *"ADDING A MEMBER TO
      A GROUP - one gesture"* and sat under a heading reading "One QUESTION each, ending in a
      verdict". **That is the reported defect itself**, not a cosmetic mislabel: a session looking
      for an add-member gesture reads the atoms section, does not find it, and writes a third one.

      **`inventory.mjs` now files by what a script DOES**, five measured sections, and asserts the
      sections PARTITION the tree - proven to throw when they do not. So the heading cannot lie and
      cannot drift. The one root file that writes a verdict, `newdevice.mjs`, is not a filing
      mistake: ten HEAL-NEW rows rest on it, so the primitive carries a row proving itself. That
      exception is now written into `atoms.mjs` beside the contract it bends, with the machine check
      that will surface a second one.

      **Two instrument bugs found on the way, both fixed, both proven.** `inventory.mjs` captured
      every multi-line headline WITH its leading `*` (a `\s*` swallowed the newline, so the optional
      prefix group never ran) - every table cell read `| * TURNS A BROWSER... |`. And
      `gate-selftest.mjs` read a SENTENCE about an import as an import: `inventory.mjs` documents
      that one script spells its path `from "./results.mjs"`, the walk matched that prose, followed
      it to the gitignored `names.mjs` and failed the whole gate on a file whose only imports are
      four node builtins. **Rewording the comment would have been the workaround, not the fix** - the
      rig documents import paths in prose deliberately - so the parser stops reading comments, and
      it was re-proven to still catch a REAL gitignored import.

      **One finding went to [backlog](backlog.md) rather than inline**: nothing lints the harness at
      all, and it carries 29 warnings nobody has been shown.

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
- [x] **B4 - DONE, and the note that named it had the files slightly wrong.** The three observers
      are `watch.mjs` (client console), **`watch.mjs` again** (`logcatSince` / `logcatReport` live
      there, not in `phone.mjs`, which holds only `clearLogcat` and `notifications`) and
      `srvlog.mjs` - and only the third had a CLI. `logs.mjs` is the one command over all three:
      `--device W1`, `--android --logcat`, `--server`, with `--since` / `--for`, `--grep`, `--raw`,
      and exit 0 clean / 1 dirty / 2 misuse. `srvlog.mjs` keeps its own CLI and is DELEGATED to, not
      reimplemented.

      **The asymmetry is written into the docblock because forgetting it cost a measurement today.**
      The phone and the estate are read BACKWARD; a browser keeps no buffer at all - `appendLog`
      writes straight to `console.log` and stores nothing - so a client line is only observable by an
      observer already attached. That is why the `[ROSTER]` line proving the P1 repair had to be
      reproduced from scratch rather than read back.

      **A silent wrong-subject bug was found and fixed on the way, and it is the reason `serial.mjs`
      now exists.** There were TWO serial resolvers with OPPOSITE policies: `phone.mjs`'s honours
      `ANDROID_SERIAL` and refuses to choose between two phones, while `watch.mjs` carried a private
      one that ignored `ANDROID_SERIAL` and returned `lines[0]`. With the Pixel attached beside the
      Mi 9T, `useDevice('A2')` bound every GESTURE to the Pixel while `logcatSince` read the Mi 9T -
      evidence gathered from a device the run was not about, with nothing saying so. It was also
      resolved at IMPORT, so a later `useDevice()` could not be seen. `watch.mjs` cannot import
      `phone.mjs` (that would drag in the gitignored `names.mjs` and break two gated self-tests on
      CI), so the pure half moved to its own module - the same split `estate.mjs` documents. Proven
      both ways: a correct `ANDROID_SERIAL` reads that phone, a bogus one reports
      `LOGCAT UNAVAILABLE: ... is not attached` instead of throwing, because an observer that crashes
      destroys the measurement it was gathering.

      **And my own renderer had the bug it exists to catch.** It derived "clean" from `dirtOf()`
      being empty - but `dirtOf` collects what should TRAVEL WITH a row, `notable` included, and
      `notable` never breaks clean. So `media-service`, carrying one routine purge line, was rendered
      as a finding while its own report said `clean`. Caught by diffing against `srvlog.mjs`, which
      disagreed and was right. Every report already carries `clean`; it is read now, not recomputed.

- [x] **B5 - DONE.** `device.mjs` now owns the plural question too. `resolveDevices()` answers a SET
      from either spelling: `--device W1,W2` (the spelling to write) or `--ports 9224,9223` (kept -
      it is in transcripts, the campaign pages and muscle memory). They are not rival paths but two
      spellings resolved by ONE implementation, and a run naming both is refused rather than
      silently resolved, exactly as `--android` contradicting `--device` is. `unlock.mjs` and
      `reload.mjs` use it; all three spellings were exercised, plus the contradiction.

      **`shot.mjs` stopped being positional and grew the half that matters.** It took
      `bun shot.mjs 9224 out.png` - two positional arguments in a rig where everything else takes
      `--device`. **On a phone it now captures the WHOLE SCREEN via `adb exec-out screencap`**, not
      the WebView: a CDP screenshot cannot see a native permission dialog, the IdP browser, a toast,
      the keyboard or a crash dialog, which are most of the reasons a phone run stalls with the
      product looking fine. That is the user's own standing rule for this rig
      (*"adb exec-out screencap -p > shot.png puis Read"*), and it was not implementable before.
      `--webview` asks for the narrow one deliberately. Verified by LOOKING at both.

      **Two defects of my own, found by using the thing.** `--out` only ever accepted a bare
      filename - `new URL('./' + out, import.meta.url)` turned `--out /tmp/w1.png` into a stack
      trace - so a path with a separator is now resolved against the CWD while a bare name still
      lands next to the runner, where `.gitignore` covers `*.png` and the public repo root does not.
      And **I passed `APP_TAB` for a phone in BOTH `logs.mjs` and `shot.mjs --webview`**: the app
      EMBEDS its frontend (`frontendDist: "../build"`), so its WebView is on `tauri.localhost` and
      never on `localhost:8081`, and `client()` answered `no target on 9333 matching localhost:8081`
      - which reads as "the tab is missing" when the needle was simply written for another platform.
      `state.mjs` had known to pass `null` for years. That knowledge existed and was not reachable,
      so it is now `tabMatchFor()` in `device.mjs` rather than a line each caller gets right alone.

      **And using it found a campaign blocker**, which is the point of building it: A1 logs itself
      out against the local estate because the refresh cookie is `SameSite=Lax` there and the
      WebView therefore never stores it - measured, three dead `auth_sessions` rows, see
      [backlog](backlog.md). Re-run `pin.mjs` before any long phone row.

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

- [ ] **C1. `ACCOUNT_OF.A2` - AND THE PHONE IS NO LONGER ATTACHED, so this is not blocking
      anything today.** `adb devices` listed only the Mi 9T (A1) at 18:35 on 2026-09-04; the Pixel
      6a the user plugged in *temporarily* is gone, which is what `state.mjs` reports as
      `A2 (9335) UNREACHABLE`. **That line is explained, not a defect** - do not spend a session
      chasing the forward. The question below is still owed the day a second phone comes back.

      **C1 (original).** The second phone (Pixel 6a) is bound and addressable on port 9335, but
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
