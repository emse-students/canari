# Backlog

Work that is **not** an open Work Package: nothing here is scheduled, and nothing here blocks the
current campaign. A Work Package is opened from an item here only when someone decides to do it, or
when a check fails and produces a captured log.

Severity uses the repo scale: **P1** security, or a user-facing path that is broken - **P2**
correctness, nothing at risk - **P3** hygiene. An item with no severity is a QUESTION, not a defect,
and its first task is to answer the question rather than to write code.

Each entry states what is known, so that picking it up does not start with a rediscovery. **Delete an
entry outright when it ships** - the rule goes to [durable-rules](durable-rules.md), the story to
`CHANGELOG.md`, the mechanism to the wiki page that entry points at. An entry describing its own fix
is an entry nobody trusts to be current.

---

## Security - blocked upstream

### P2 - `libcrux-chacha20poly1305` panic on an overlong ciphertext buffer, in the MLS path

**The only one of the 16 open Dependabot alerts that reaches attacker-controlled input on a path that
matters.** `frontend/mls-wasm/Cargo.lock` pins 0.0.7; the advisory is fixed in 0.0.8. It arrives
transitively as `openmls_rust_crypto` → `hpke-rs` → `hpke-rs-libcrux` → `libcrux-aead` →
`libcrux-chacha20poly1305`, i.e. it IS the HPKE half of the MLS crypto provider, and it processes
ciphertext supplied by whoever sends this device a frame. A panic there kills the MLS client inside
the WASM module. Availability, not confidentiality - no key material is exposed.

**It cannot be bumped today, and this was tried rather than assumed.** `libcrux-aead 0.0.7` pins
`libcrux-chacha20poly1305 = "=0.0.7"`, and a `0.0.x` requirement is exact in Cargo semver, so the
whole chain has to move together:

| crate                      | locked | needed | available                                            |
| -------------------------- | ------ | ------ | ---------------------------------------------------- |
| `libcrux-chacha20poly1305` | 0.0.7  | 0.0.8  | yes                                                  |
| `libcrux-aead`             | 0.0.7  | 0.0.8  | yes                                                  |
| `hpke-rs-libcrux`          | 0.6.1  | 0.7    | yes                                                  |
| `hpke-rs`                  | 0.6.1  | 0.7    | yes                                                  |
| `openmls_rust_crypto`      | 0.5.1  | 0.6    | **release candidates only** (0.6.0-rc.1, 0.6.0-rc.2) |

So closing this alert means shipping a release candidate of the MLS crypto provider. That is not a
dependency bump, it is an openmls provider upgrade with a full MLS re-verification behind it, and it
must not ride along with anything else.

**Re-check when `openmls_rust_crypto 0.6.0` goes stable** - that is the whole condition. Until then
the alert stays open on purpose, and the reason is here rather than in somebody's memory.

---

## Open questions - no code until they are answered

### P2 - what made the profile fetches fail on that device at that moment

**The MECHANISM is closed** (2026-08-16): the swallowed `catch` now accuses, a reconnection clears
`failedAt` because a failure recorded while the network was down is evidence about the network rather
than about the user, a failed lookup answers `null` instead of the label that overwrote names the
caller already had, and `displayName.spec.ts` pins all of it.

**What is owed is the DENOMINATOR, and it is a measurement rather than a change.** The log line that
makes it countable did not exist when the symptom was seen - twice on 2026-08-16, on both platforms,
nine of ten sidebar rows carrying "Utilisateur inconnu" for twenty seconds. With it in place, measure
how often that `catch` actually fires and against what population, and only then decide whether the
two-minute backoff has any case left to serve. Do not assume it is the same fault as the avatar
endpoint, and do not assume it is not.

### QUESTION - does an iOS attachment CONSUME the avatar cache file it is handed?

Found 2026-08-17 while writing the initials fallback, and it is a question rather than a defect
because settling it needs an iPhone. `CanariShowLocalNotification` hands `attachmentPath` straight to
`UNNotificationAttachment`, and for an avatar that path IS the durable cache file `avatar_<id>.jpg`
that `CanariFetchAvatar` writes and later re-reads. The NSE does the opposite on purpose: its
`attachImage` copies to a temp file first, carrying the comment *"an attachment URL is
consumed/moved by the OS, so we never hand it a shared cache file directly"*.

Both cannot be right. If the OS really moves the file, the app-process cache is emptied by its own
first hit and every subsequent notification re-fetches - a silent, permanent cache miss that no log
would name, since a re-fetch looks exactly like a first fetch. **What settles it is one device
observation**: notify twice for the same person with the app alive, then look for `avatar_<id>.jpg`
in the app container. If it is gone, the app path copies too, exactly as the extension does. The
initials disc is unaffected either way - it writes to `NSTemporaryDirectory()` on both.

### Mobile - what happens when the device runs out of space?

Unanswered today. The device window on mobile is five years, which is a TIME bound and not a SIZE
bound, so nothing caps the store. Worth knowing what the failure actually looks like before deciding
whether a cap is needed - a write that throws is a different problem from a device that silently
stops persisting.

### Browser - is 90 days bounded in bytes?

Same shape as mobile, and the same gap: the web window is a time bound. IndexedDB is also subject to
the browser's own quota eviction, which can drop the store without asking - the question is what the
client does when it finds its store gone, not whether it can prevent it.

### Is a MiGallery application worth it?

An open question, deliberately. The Canari formula (SvelteKit + Tauri) transfers, so the cost is
knowable - but MiGallery's value is a gallery that a browser already renders well, and the question
is what an app would add that the web version cannot do. Answer that before estimating anything.

---

## Owed to somebody else

### P2 - Le Cercle's avatar proxy caches nothing

The last of the four projects that fetch `gallery.mitv.fr/api/users/<id>/avatar`. Canari, Sky and
Portail-etu were aligned on 2026-08-16 - the contract, the three outcomes and the caching rule are on
[core-service](services/core-service.md#the-avatar-proxy) - and each keeps its budget in ONE constant
per repo, which is the shape a fifth project should copy.

Le Cercle re-asks the gallery for a known-absent photo on every render: the amplification the cache
exists to remove. **It is Aurel's repository**, so this travels as a merge request or not at all,
never a commit on his `main`.

### P2 - converge the five projects on the best version of each shared solution

**The avatar proxy is the sample, not the subject.** Four projects wrote four different failure
behaviours for one endpoint, each in isolation - one had no deadline at all, one dressed a refused key
as "this member has no face", one narrated every request, and only one cached. **Nobody chose that
spread**, and the best version never travelled. Three are aligned now, which settles the contract but
not the process: alignment took one person reading four repositories in one sitting, and nothing makes
the fourth follow or the next shared solution converge.

**What this asks for is an inventory first, not a refactor.** What is actually established today:

- **verified** - the avatar proxy, four implementations, three aligned;
- **known partial** - tolerant search (done in Sky and Canari, owed in MiGallery), and the i18n /
  wiki / English-comments normalisation (done in Canari, partial elsewhere);
- **to inventory** - outbound HTTP handling in general (timeout, retry, what a failure degrades to),
  logging conventions, and whatever else turns up. Do NOT enumerate these from memory - a guessed
  inventory is how the refuted IPv6 diagnosis got written down.

**A shared package is probably the wrong shape, and that is worth deciding before any code.** Three
of the four are SvelteKit and Canari's is NestJS; there is no monorepo spanning them; and Le Cercle is
Aurel's repo. The realistic form is *one written contract, four aligned implementations*, with the
contract living where it can be read from all five - and its first clause is the one the avatar case
already proves: **an optional decoration that cannot be fetched degrades, it does not error.**

### P3 - SEO for Sky, MiGallery and Portail-etu

Canari's is done and the method is written up in [seo](frontend/seo.md), including the four checks no
test can make. The three other repos have had none of it. Each is a separate repo and a separate
deploy, so this is three small pieces of work sharing one method, not one piece of work.

### P2 - MiGallery's search is still plain substring

The user's standing requirement is that every search box across the ecosystem tolerates typos and word
inversion and ranks by edit distance. Done in Sky (`personMatchScore`) and in Canari
(`applyFuzzyNameSearch`, pg_trgm + unaccent); never started in MiGallery.

---

## Measurements owed

### P2 - measure EGRESS over time, because two unrelated upstreams stalled in one window

The code half is fixed: `UpstreamUnreachableError` classifies at the throw, so an unreachable host is
a **502 `no-store`** never remembered, while an answer about the URL stays a cacheable 400; and
`OUTBOUND_BUDGET_MS` is the single budget, set on the `AbortController` AND on the undici dispatcher,
so the stated budget is the one that fires. Pinned by `security.controller.link-preview.spec.ts`.

**What is owed is not a code change.** Within one three-minute window on 2026-08-15, two unrelated
upstreams timed out from two different containers (`chat-delivery-service` → Wikipedia at 14:37:02,
`core-service` → gallery at 14:39:58). That is not evidence about either upstream, and it is the
second time this shape has been mistaken for one - the IPv6 reading was refuted by measuring the
components, which all came back healthy. **Measure EGRESS over time rather than the endpoints again**:
the component probes already say each is fine at the moment it is asked, so what is left to establish
is whether these stalls are CORRELATED, which a one-shot probe cannot answer by construction.

---

## Interface

### P3 - iOS has no home-screen icon, and `/favicon.ico` 404s too

Measured on prod 2026-08-16, re-confirmed 2026-08-17: `/apple-touch-icon.png`,
`/apple-touch-icon-precomposed.png` and `/favicon.ico` all answer **404**. `frontend/static/` holds
only `favicon.png` and `favicon.svg`, and `src/app.html` declares those two and nothing else - so
Safari falls back to the convention path, finds nothing, and an "add to home screen" gets a page
SCREENSHOT instead of an icon. On a chat app whose mobile install path matters, that is the first
thing a user sees on their springboard.

Fix is one asset and one `<link>`: a 180x180 PNG at `static/apple-touch-icon.png` plus
`<link rel="apple-touch-icon">`. A `favicon.ico` alongside them costs nothing and closes the third
404 - some browsers and most feed readers still ask for it before reading the declared icons.

**The 404 itself is not a server defect** and is classified BENIGN in `srvlog.mjs`: answering 404 to a
path this site does not have is correct. It is filed here rather than only silenced there, which is
the whole difference between classifying a line and hiding one - the rule carries a comment pointing
at this entry so the two cannot drift apart.

### P3 - the whole mobile page is selectable

Reported 2026-08-13, seen while reading a CDP dump: a long press on the phone selects page chrome -
navigation labels, section descriptions - not just message text. Only message content should be
selectable, and arguably nothing else at all. One `user-select` rule at the layout level with an
explicit opt-in on message bodies.

### P3 - merge "Connexions actives" into "Gestion des appareils"

Two panels describe the same thing and neither is complete, so the user reads both to answer one
question. **One panel**, one row per device, carrying:

- a name that lets the reader recognise their own device - the current wording does not, and that is
  the point of the merge rather than a detail of it;
- the **last connection**, which is what "Connexions actives" was for;
- the **browser / platform**, the other half of recognising a row;
- the first characters of the device id, for debugging - a fallback for when the wording fails, not a
  substitute for fixing it.

**Drop the IP.** It is shown today and it answers nothing the reader asked: it does not identify a
device (a phone changes it between wifi and mobile data, several devices behind one connection share
it) and it is not actionable. Removing a column is part of the merge, not a separate task.

**The trap is the last-connection column, and it has already been paid for once.** A liveness clock
must be written by the thing whose liveness it measures: reusing a row's `updatedAt` once kept nine
dead devices alive for ever, because every unrelated write refreshed it. Before displaying a
timestamp, establish which column is written _by the connection_ - and if none is, the merge needs
that column first. See [durable-rules](durable-rules.md).

**Both halves of the delete question are decided (2026-08-17): deleting a device PURGES its queue, and
the backlog of a device that never returns is BOUNDED.** The second is the one nobody triggers by hand
- a user is under no obligation to delete anything, so a queue that only shrinks on an explicit delete
grows for ever on exactly the devices that are worst at coming back. The bound is a question for the
sweep that already deletes at `RETENTION_WINDOW_MS`, not a new mechanism. Measured 2026-08-13 on an
abandoned device of a real account: 1383 undelivered rows in `queued_message`, still growing that day
because the other members kept addressing it.

### P2 - a deleted message still offers the emoji picker, and using it throws

Measured by MUT-17 on 2026-08-15. `MessageBubbleToolbar.svelte` gates the quick-reaction strip on
`!isDeleted`, but the "open the full picker" (smile) button is passed on `onReact` alone, with no
`!isDeleted` anywhere in that prop's derivation. So on a tombstone the strip correctly disappears and
the picker button stays.

Observed, on the same row, in one pass: `smileOnDeletedPresent: true`,
`quickStripOnDeletedPresent: false`, `reactAttempted: true`, **`reactSucceeded: false`**, and W1
raised `TypeError: Cannot read properties of undefined (reading 'replace')` at that exact moment. The
row itself is undamaged on both clients, so nothing is corrupted; an affordance is offered that cannot
work and that throws when used.

Two things to decide together: whether the picker button should be gated on `!isDeleted` like every
other action (it should - a reaction to a tombstone means nothing), and what the `replace` is reading,
since a guard on the button would hide that crash rather than fix it.

**A later MUT-17 run read `smileOnDeletedPresent: false`** - confirm that before deleting this entry;
a check that changed verdict without a change to the code it measures is itself a finding.

---

## Protocol and delivery

### P3 - the composer sits behind the soft keyboard on Android, and the page scrolls onto a white band

Known, reproduced by hand. Two symptoms, and reading them together is what makes this a layout
decision rather than a patch:

- the message composer is overlapped by the soft keyboard on some Android keyboards;
- with the keyboard open, **the interface itself scrolls** - resting a finger on the text bar and
  dragging moves the whole page off the conversation and onto an empty white band below it.

**They are one defect.** The white band is the LAYOUT viewport keeping its full height while the
VISUAL viewport shrank to make room for the keyboard: the page is still as tall as the screen was, so
the part now hidden behind the keyboard is scrollable into view, and it holds nothing. The composer
sits in that same overhang. Anything that pins the composer alone leaves the band.

**Decided 2026-08-17: let the OS resize the view** - `adjustResize` on the activity plus
`interactive-widget=resizes-content` in the viewport meta - rather than translate the composer from a
`visualViewport` listener. The layout shrinks, so there is no overhang to scroll into and no event to
chase; it is one setting rather than a correction applied after the fact, and it fixes the whole
column instead of one element of it.

**The check the user asked for, and it is a good one because it needs no coordinates**: with the
keyboard open, **at least 5 messages must be visible in the conversation**, read off a screenshot.
Fewer means a band survives between the list and the keyboard. Negative control is free - the current
build fails it, so the check can be seen failing before it is believed
([testing-methodology](testing-methodology.md), rule 2).

### P2 - a server-composed notification body is French for everyone, and cannot be otherwise

**The whole CLIENT half is done** (Android and iOS, 2026-08-17): each platform has a two-language
table read through the locale the user chose inside Canari, and `nativeStrings.test.ts` holds all four
resource files to the same key sets plus the invariant that no native source may carry a literal a
table already translates. Mechanism on [mobile](frontend/mobile.md#the-language-a-notification-speaks).

**What is left is the services, and it is not a translation problem.** `chat-delivery-service` and
`social-service` compose French sentences for pushes and do not know the recipient's language - no
header carries it and no column stores it. Paraglide compiles into the web bundle and reaches neither
the native clients nor the services, so the rule "user-visible strings use Paraglide" has no
enforcement mechanism at all outside the bundle. The MESSAGE push path already answers this correctly
by sending `body: ''` and letting the device compose after decrypting, which is the only layer that
knows the locale. **Any server-composed body is therefore a design smell rather than an untranslated
string, and the fix is to MOVE THE COMPOSITION** - which is also why storing a `locale` column
server-side would be the wrong repair.

### P3 - a backup that fails to export or import tells the user nothing

Found 2026-08-16. `sessionBackup.ts` catches both failures and hands them to `log`, which is
`appendLog`, which is `console.log`. The spinner stops and nothing else happens: a file the importer
refused and a backup fully restored look identical on screen, and seven distinct refusals in
`importBackup` are equally invisible.

**This is also why those seven sentences were made ENGLISH rather than Paraglide messages** - nothing
user-visible carries them today, and the rule is that a dev-facing string is English. Inventing a
surface for them is a UI decision, not a translation one: whoever picks this up decides what the user
actually sees (a toast naming the refusal, or a panel), and the sentences become Paraglide messages in
the same change, never before it.

---

## Storage and retention

The server side has a page already - [storage-forecast](infrastructure/storage-forecast.md) - and it
is where any measurement belongs.

### Server - can occupancy be monitored, and will it hold?

The forecast exists on paper; what is missing is a live measurement over TIME. `/admin/storage`
already answers disk, `auth_db`, bucket size and object count, and Redis memory - but only as TOTALS,
and only when somebody goes and looks. Scope: what is actually growing (Postgres, Garage, Redis
streams), at what RATE, and a presentation that distinguishes "media grew" from "the retention stopped
working" - two causes with the same symptom and opposite fixes. The second is not hypothetical:
`purgeExpiredMedia` iterates the metadata index, so an object with no entry is invisible to it for
ever, and 7 such objects (~11 MB) are already measured. §5.7's WP-GHOST-1 shape belongs on the same
panel: a device holding memberships with no `key_package`, or more than a few hundred `queued_message`
rows.

**Decided 2026-08-17: the panel is the whole of it, there is NO alert.** The user's call. Worth
stating what that costs rather than pretending it costs nothing - the standing rule is that a correct
mechanism with no report is found by hand a day late, and a panel is a report only for whoever opens
it. The slope is what makes it survivable: a number read once a month against a trend is enough to see
a wall coming, where a bare total is not.

> **Already shipped, do not re-open:** _"ne garder que les messages les plus recents (dernier mois),
> et le reste recuperable en demandant l'historique a un appareil mobile"_ is exactly the device
> window plus the scrollback range request delivered in the history-reconciliation rework - web keeps
> 90 days, mobile and desktop 5 years, and reaching the top of the scrollback asks a peer for the
> range below the window. See [history-reconciliation](protocols/history-reconciliation.md) and
> `historyWindow.ts`.

> **Already shipped, do not re-open:** _"pourquoi garder plus d'un accuse de lecture sur de vieux
> messages ? Si le dernier message a ete lu, le precedent aussi"_ is the read watermark that replaced
> per-message `readBy` in the same rework - read state is now ONE timestamp per (conversation, user),
> and `readersOf` derives the per-message display from it.

---

## Payments

### Flipping `payment_provider` from Stripe to Lydia (WP-LYDIA-1)

**The code is not the blocker - it is already written and tested.** `PaymentProvider` is an interface
(`apps/core-service/src/payment/payment-provider.interface.ts`), `LydiaPaymentProvider` implements the
two flows that map cleanly onto it (one-off checkout, session lookup) with its own signature module
and specs, and the choice is a platform config column (`payment_provider`) that **defaults to
`stripe`**. Stripe is what runs today and nothing about that is broken.

What is missing is not code, which is why this is a question and not a P-anything: the **credentials**
and the **answers Lydia owes**. Everything that does not map - live balance and status, saved payment
methods - throws a documented error rather than faking a result, and that is deliberate: Lydia has no
live status-poll endpoint, and the saved-card flow was **explicitly dropped by the user** rather than
reimplemented, so every purchase becomes its own interactive request. Do not re-litigate that.

The full provider mapping, the remaining open questions and the credentials still owed are in
[`plans/stripe-to-lydia-migration.md`](../../plans/stripe-to-lydia-migration.md), which the wiki page
[payments](frontend/modules/payments.md) already points at.

---

## Tooling

### P3 - move and rename `test_adb.py`

It sits at the repository root and its name says what it uses rather than what it does - it captures
device logs for the verification pass. It belongs with the harness documentation that references it
([device-verification](device-verification.md)). A rename touches every doc that names it, so grep
before moving.

---

## Post-campaign projects - decided, not scheduled

### One MLS client in a SharedWorker - decided 2026-08-17

**It would remove the multi-tab class outright**, and that class is not theoretical: W2 was measured
carrying seven `canari-emse.fr` tabs, each a full MLS client with its own gateway socket and its own
in-memory counters, sharing one IndexedDB key. Two campaign findings dissolved on that fact alone
(see [testing-methodology](testing-methodology.md), rule 5), and the harness's answer - `client()`
refusing an ambiguous browser, `onetab.mjs` repairing it - protects the INSTRUMENT and not the user.

**Why it is not a queue item.** The cost is not the worker: it is the worker TRANSPORT, the startup
sequence, the PIN unlock and the Safari/mobile fallback, all of which have to be redone. Doing it
before the campaign would invalidate every verdict already taken, since the boot path is what half of
them measure.

### `dev.canari-emse.fr` becomes a real second environment - decided 2026-08-17

Today it is a proxied CNAME onto the same tunnel as production - one environment wearing two names.
The user wants trials to stop happening on prod, which is the right instinct: every reproduction is
authorised on prod only because there is nowhere else, and each one leaves debris on a shared server
that real members use.

**What has to be decided before any of it is built**, because a second environment is a second copy of
every secret and every service: whether it gets its own database or a snapshot of prod's, its own
object storage, its own push credentials (an FCM sender is per-project, so a shared one would send a
test notification to a real phone), and whether its data is ever restored from prod - which would
carry real people's ciphertext onto a machine with weaker rules. Scope that first; the tunnel and the
DNS are the easy half, and they are already in hand.

### A SECOND campaign, for everything that is not chat - asked for 2026-08-16

**It is a second campaign, not more sections on this one** - the user's framing, and it settles a
structural question. The expected size is dozens of checks per surface, where the current dashboard
already carries 18 sections in one file whose entire job is to be a LIVE summary someone can read.
Pouring a second campaign into it destroys that property. So: its own dashboard, its own manifest, its
own phase files - and `checks.mjs`'s phase list is the seam to look at first, since a second campaign
must be runnable without re-running this one.

The 18 sections were written around one class of failure: a message crossing between two transports
and two platforms, and the silent loss that class produces. That leaves whole surfaces with **no check
at all** - posts, forms, communities as a management surface, profiles, media browsing, calendar,
payments - and a surface with no check is not a surface that works, it is one nobody has asked about.

The named starting point is the **`social` notification family**: a post, a comment, a reaction on a
post, a form alert. It does **not** share the chat path - no MLS, no per-device fan-out, no outbox -
so none of the verdicts already taken transfer to it, and its delivery is server-decided, which is a
different failure mode (an audience computed wrong notifies the wrong people, and nothing on the
client can detect that).

Three things must be settled BEFORE writing checks:

- **The venue.** Every existing check sends into the two-test-account DM or `Campagne de test`
  precisely because production is shared. A post or a form alert has an AUDIENCE, so the same
  discipline needs an answer that does not exist yet: what does a test post look like that no real
  member is notified by? Until that is answered, no social check may run on prod.
- **The observer.** `srvlog.mjs` partitions its window by subject and classifies every line. The
  services behind posts and forms are not in that window today, and an unclassified window is not an
  observation.
- **What a verdict rests on.** A chat check reads the peer's DOM. A notification with an audience is
  only correct if the people who should NOT get it did not - an assertion about absence, over a
  population, needing its window sized from a measured latency rather than guessed
  ([testing-methodology](testing-methodology.md), rule 13).
