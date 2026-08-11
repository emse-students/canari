# Testing methodology: how a result earns the right to be believed

This page is about **measurement**, not about any one feature. It is the distillation of the
**thirty-one harness faults** that produced a false verdict during the
[cross-client campaign](cross-client-testing.md) - each one a check that reported PASS or FAIL for a
reason that had nothing to do with the application.

It is worth its own page because the faults are not campaign trivia. Every one of them is a way of
being wrong that survives the harness that produced it, and several of them cost a shipped bug: a
green check whose noise was ignored, an invented app defect that was a selector, a verdict computed
over a filtered copy of its own evidence.

> **Read this before writing a check**, and before believing one. The
> [rig itself](../../tools/cross-client-harness/README.md) is a separate document: that one is the
> instrument, this one is the epistemics.

---

## The eight rules

Ordered by how expensive it is to break them.

### 1. A verdict must never be computed over a projection of its own evidence

`heal-web.mjs` filtered the console through a **display** regex, then ran its matchers over the
**filtered** text. A line the matcher accepts but the filter drops is invisible, so the check
reported `escalated=false` on a run whose repair had demonstrably run.

A capture filter is presentation. The verdict reads **everything** the run produced, and only the
report is abridged. If the two must share a regex, the verdict's is the superset - never the
other way round.

### 2. Every action asserts its own post-condition

An action that cannot prove it took effect still yields a verdict, and **that verdict is fiction**.
The campaign produced this one five separate times:

- `am kill` on a **foreground** process is a silent no-op - it returns success and the app lives.
  Go HOME first, then assert the death (`pidof`).
- A "relaunch" that opened a new tab instead, so the check measured a fresh page that had never been
  through the transition it was testing.
- A `pidof` that exits 1 **exactly when** the thing it measures happens, so the harness read the
  failure as a shell error.
- A navigation that failed, was swallowed, and left the check counting rows on the previous screen.
- A zoom button never clicked, because the guessed `aria-label` did not exist - the check still
  asserted "something changed" and passed.

### 3. "Did the state change" is almost never the assertion. "Did it change into the RIGHT state" is

The corollary of the last item above. A pinch check asserted that the scroll position moved; it
moved, and the page had zoomed about the wrong point, which is the entire defect the check existed
to catch.

**Validate every check as a NEGATIVE CONTROL against the unfixed build before its green means
anything**, and set its tolerance from those two measurements rather than from taste. A check that
has never been seen to fail is not a check.

### 4. Assume a green check is wrong until its evidence says otherwise - and a FAIL too

A FAIL is not evidence about the application until the fixture and the selector have been ruled out.
Two examples on opposite sides:

- A media check passed against a fixture whose PNG CRCs were invalid - it was never rendering
  anything.
- `check-feed-retry` reported FAIL against a feed that was visibly rendering posts, because it
  counted `article` / `data-post-id`, neither of which the feed emits (`PostCard`'s root carries
  `group/card`).

**A locator failure does not bias the verdict in a predictable direction**, which is why it cannot
be discounted as "conservative".

### 5. A locator is a guess unless it is disambiguated - and a DEVICE is a locator

Name an element from the **component source**, never from what the markup ought to be. Scope any
selector shared by two surfaces: `.chat-composer-editor` also exists on the social feed, so every
use is scoped to `.chat-composer-footer .chat-composer-editor`.

The device half is the same rule one level up: with two adb transports attached (USB and TCP), every
`adb` call needs `-s <serial>`, and the serial is **resolved** from `adb devices` rather than
hard-coded. `/json/list` is not creation order, so a CDP target must be identified by what it
contains, not by its index.

An `aria-label` must never outrank visible text, and a document-wide text match hits the first
hidden row.

### 6. A matcher tests one SPELLING; the absence of an entire VOCABULARY is evidence about the app

When a mechanism leaves no trace, a **stale matcher is the right first suspicion** and it is cheap
to rule out: grep the log for every word the mechanism could have used, not for the one string the
check happens to look for. Only once the whole vocabulary is absent does the silence say something
about the application.

Its mirror image: two lines that **no longer exist in the codebase** appearing in a run means the
client is on an old build. Check the deploy before believing anything else that run says.

### 7. A check that puts the app through a transition must restore every precondition that transition destroys

A kill, a reboot, a radio cycle and an `install -r` **all re-lock the PIN**. A precondition
discovered by one check belongs to every check sharing the transition, so it goes in the shared
setup, not in the check that found it.

### 8. When a check's BREAK is not invertible, the teardown restores a PROPERTY, never a snapshot

Rewinding a sender cannot be undone by restoring any state: while the fork was live, the peer
consumed generations off it, so **no snapshot is both legitimate and ahead of the peer**. Restoring
one re-creates the very break.

Ask what the next run actually needs - "can this device still deliver?" - and assert that invariant
on every exit path (`ensureDeliverable`). A teardown that only runs on the happy path is not a
teardown.

---

## Observation is part of the check, not a debugging step

Decided 2026-08-06, after two shipped bugs came out of the logs of **passing** checks.

A check that only asserts its own outcome answers "did the message arrive", never "did it arrive for
the right reasons" - and a pass sitting on a swallowed exception, an unread 4xx, a request that
should not have been made, or a reconnect mid-measurement is worth nothing.

`watch.mjs` therefore attaches to every client for the duration of every check and sorts what it saw
into buckets, reported next to the verdict:

| Bucket | Meaning |
| --- | --- |
| `errors` / `exceptions` / `badHttp` / `wsEvents` | anything here makes the run **not clean**, whatever the assertion said |
| `notable` | not an error, but it happened: `SecretReuse`, `out of bounds`, `Duplicate`, `silent ACK`, `epoch`, `GAP`, `out-of-sync`, `welcome_request`, `forget`, `revoke` |
| `stateChanges` | the client changed under the check's feet - gateway reconnect, token refresh, session change. Explains a latency or a retry that would otherwise look like a result |
| `unexplained` | everything not on the known-benign list, **verbatim** |

A verdict is `PASS` only when the assertions hold **and** the run is clean; otherwise
`PASS-WITH-NOISE`, which is a result that still needs reading.

**A line that turns out to be routine is ADDED to the benign list, never ignored in place.** That is
the whole mechanism: the `unexplained` bucket only keeps its value if it shrinks by decision.

---

## Reconciliation: the only way a silent loss can be seen

A silent loss leaves no mark anywhere a **single** client can look. The sender keeps its optimistic
echo, the server answered `201`, and the receiver simply never had the row - so both UIs are
self-consistent and both are wrong about the conversation. The only evidence is a **set difference**
between two clients' view of one thread.

Every campaign message therefore carries a unique `PREFIX-<base36>` marker: DOM rows have no id, but
the text does, and the marker embeds its own send time.

Getting this measurement right took two corrections, and **the first version of it stated a
conclusion that was wrong**. Both are recorded because either one silently produces an
authoritative-looking diff made of noise:

- **The list is VIRTUALISED.** `innerText` holds only the rows currently rendered, so scrolling to
  the top and reading once returns the oldest screenful and drops everything between. The first run
  did exactly that and reported two messages permanently lost. They were not - the peer had both.
  The collector now reads at every scroll position and accumulates.
- **The two windows do not coincide, and deriving the bound from the data does not fix it.** Each
  side loads whatever its scrolling reached, so a marker absent from one list may simply be older
  than that side went. Bounding to "the newer of the two oldest markers" still makes the answer
  depend on how far each run happened to get - **two consecutive runs disagreed**, one calling a
  dozen messages lost that the other reconciled. The window is FIXED (`RECON_WINDOW_MIN`, 90 min by
  default) and each side must hold at least one marker OLDER than it, which is the only evidence it
  covered the range. A diff reported without `covered` **and** `trustworthy` is not a result.

**A diff between unequal windows looks authoritative and is noise.** No per-check verdict substitutes
for reconciliation: it is what found WP-LOSS-1 and WP-ECHO-1, and both were invisible to every check
that was passing at the time.

---

## Reading a repair on the wire

The repair mechanism is **invisible to the network panel**: the diff travels as encrypted MLS
application frames, so the server sees one HTTP call and nothing else. The whole negotiation is
observable only in the CONSOLE. The design is in
[chat > pooling history between devices](frontend/modules/chat.md); this is the map from that design
to what a run can grep.

The only server-visible seam is `POST /api/mls/history-request` (`messaging.controller.ts`), which
elects one online member and relays, logging `FORWARDED target=…` or `NO_PEER_ONLINE`.

| Console prefix | Emitted by | What it tells a check |
| --- | --- | --- |
| `[HISTORY_REQ]` | requester + responder | the whole negotiation, both ends |
| `[HISTORY_DIGEST]` | requester broadcast, responder receipt | leg 2 arrived, and in which mode |
| `[HISTORY_PULL]` | responder -> requester | the REVERSE direction (the requester holds more) |
| `[HISTORY_BUNDLE]` | responder | what was actually shipped, filtered by id |
| `[MLS]` | `setupMessageHandler` | the escalation from a decrypt failure into the diff |

Four lines decide a verdict, and each says something different:

- `…: N to send, M to pull (identical stores)` - **the diff RAN**. This is the success line.
- `no digest from <identity> … - sending the whole store` - **the fallback fired.** Not a failure,
  but the run did not test what it meant to: the `HISTORY_DIGEST_GRACE_MS` rendezvous lost, so this
  is the old full dump wearing the new mechanism's name. Re-run it.
- `store unreadable - staying silent so another member answers` and `nothing to add and we are
  awaiting history too - staying silent` - a **deliberate** silence.

That last one carries a rule of its own: **a responder that stays silent looks exactly like a
responder that never got the request**, so a check asserting "no repair happened" must read the
responder's console too, never only the requester's.

Two further facts a HEAL verdict depends on:

- **The digest logs its MODE, and the mode is part of the verdict.** `ids, N id(s)` is an exact diff;
  `range, N slice(s) at depth D` is the size fallback, which resolves to a slice of the **id space**.
  A run reporting `range` exercised a different code path from one reporting `ids` - say which.
- **A responder is elected at RANDOM** among all online devices except the requester's own
  (`messaging.service.ts`), so every run must record **which device answered**. Two runs of one check
  can exercise two code paths on two machines, and the greener verdict is the one that says less.

Since there is now exactly one repair, any repair observed **is** the diff. What replaces the old
"which mechanism was that" question is a quantitative one every HEAL check must answer instead:
**how much traffic did the repair cost?** The deleted rung was a broadcast (~450 frames/min for over
ten minutes, repairing nothing), so a run whose frame rate does not fall back to the ordinary send
rate has found something.

---

## Environment traps that read as application bugs

These are not faults of judgement - they are platform behaviours that will be mistaken for defects
by anyone who has not met them.

- **Chrome discards every input event on a page it considers hidden**, and native occlusion detection
  marks a fully covered window hidden while `windowState` still says `normal`. Hence the
  `--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows` launch
  flags. A backgrounded tab must be made by focusing another **tab**, never by covering the window.
- **Only one OS window can have focus**, so two browsers cannot both report `hasFocus: true`. A check
  that asserts focus on both is asserting something impossible.
- **`am force-stop` is NOT "the user killed the app".** Android's STOPPED state cancels every FCM
  broadcast until a manual launch, so any push-dependent check must use a swipe from recents or
  `am kill`.
- **CDP's Network domain is BLIND to the app's own requests on mobile**: `hooks.client.ts` swaps
  `window.fetch` for the Tauri plugin's Rust client. Record from **inside** the page, inject failures
  there too, and keep such navigation client-side or a reload takes the patch with it.
- **An offline RECEIVER cannot be faked in the browser.** `emulateNetworkConditions` fails new
  requests in ~10 ms and the receiver still renders the message; only the SENDER side is faked
  faithfully. A true offline receiver needs the phone's radios
  (`svc wifi disable` + `svc data disable`).
- **`window.open` returning `null` is not proof of a blocked popup** - the spec permits `null` for a
  cross-origin window that did open.
- **Clicking through to an external app backgrounds the WebView**, which throttles it, so every read
  taken after that point is against a frozen page.
- **`tail`-piped output buffers until EOF**, so a progressing job looks hung.
- **Postgres stores UTC while the prod host is `Europe/Paris`**, so a DB timestamp is two hours
  behind the wall clock a test just wrote down. Both are correct; convert, and never "fix" the
  server clock.
- **A virtualised count needs a FRESH MOUNT and the max over repeated polls**; a count taken while
  rows are still loading is non-monotonic and undercounts.
- **A baseline needs a polled budget, not a fixed wait.** A fixed sleep after a send reported a
  healthy link as lossy.
- **A conversation-scoped banner only renders inside `ChatArea`**, and its phase store is in-memory,
  so "no banner" is meaningless unless the check asserts the conversation is open **and** the
  observation window spans a fresh attempt. After a reload, "no banner" is guaranteed and proves
  nothing.

---

## Where a result goes

- **PASS** -> one row in the [dashboard](cross-client-testing.md), with the build it ran against.
- **FAIL** -> a Work Package in `CLAUDE.md`, severity per its rules, **with the captured log inline**.
  A durable marker written without its evidence is legacy.

The campaign is not done when the tables are full. It is done when every FAIL is either a Work
Package or a fixed commit, and the dashboard says which build produced each verdict.
