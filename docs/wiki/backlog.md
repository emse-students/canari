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

### P2 - converge the five projects on the best version of each shared solution

**The avatar proxy is the sample, not the subject.** Four projects wrote four different failure
behaviours for one endpoint, each in isolation - one had no deadline at all, one dressed a refused key
as "this member has no face", one narrated every request, and only one cached. **Nobody chose that
spread**, and the best version never travelled. All four are aligned since 2026-08-18, which settles
the contract but not the process: alignment took one person reading four repositories in one sitting,
and nothing makes the next shared solution converge the same way.

**What this asks for is an inventory first, not a refactor.** What is actually established today:

- **verified** - the avatar proxy, four implementations, all four aligned;
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

**SCHEDULED 2026-08-18 (the user): in scope, item 7 of the queue in `CLAUDE.md`.** Port whichever of
the two fits what that repo actually has - Canari's if it reaches Postgres, Sky's client-side
scoring if it does not.

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

### P2 - an admin announcement, shown once per account - ASKED FOR 2026-08-18, SCHEDULED

The user asked for a place in `/admin/platform` to publish a message that people see the next time
they open the app. Every shape below is the user's decision of 2026-08-18, taken before any code was
written; it is **item 6 of the queue in `CLAUDE.md`**.

- **Once per ACCOUNT, not once per device.** Whichever device opens the app first shows it, and it
  never appears again anywhere. That makes the "seen" state server-side by construction - which is
  the point: local state is wiped by a reinstall, and an announcement that reappears after one is
  worse than none.
- **A centred modal**, title and body, closed by one button. Chosen over a dismissible banner
  deliberately: a banner is a line its reader learns to skip, so "seen" would stop meaning seen.
- **French and English both entered**, shown per the language chosen in Canari. No inline literal,
  no fallback to one language - it would be the only user-visible string in the app not to follow
  the user's language.
- **One active announcement at a time**, with an OPTIONAL client version range so "what changed in
  0.15" reaches only clients that have it.

Three things the implementation must not get wrong, each from a rule this repo already paid for:

- **The "seen" row answers exactly one question - "has this account seen announcement X".** Not "is
  the account current", not "has it been notified". Two questions differing only in lifetime are how
  a durable-state trigger gets silenced.
- **It lives in `platform_config`'s neighbourhood, not in the code.** Publishing must not need a
  deploy, exactly as `minClientVersion` does not.
- **The version range is a filter, never a gate on delivery.** A client outside the range must not
  be told an announcement exists and refused it; it must simply have none.

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

## Communities and permissions

Six entries came out of ONE audit on 2026-08-17, prompted by a user question rather than by a
failure. **Five of them shipped on 2026-08-18** and are not repeated here: the mechanism is on
[social-service](services/social-service.md#a-community-always-has-an-admin-or-it-has-no-members-2026-08-18),
the audit and its prod figures on [community-rework](services/community-rework.md), the rule in
[durable-rules](durable-rules.md), and the story in `CHANGELOG.md`. One remains, and it remains
because the user decided it is not a defect.

### P3 - "delete community" still archives, so its rows are permanent

An admin deleting a community sets `archived = true` on the workspace and its channels; the members,
the messages and the media stay. That was defensible while a mistake had to be recoverable "with two
UPDATEs" - it is less so now that the same page has a HARD delete on the neighbouring path (the last
member leaving), and it becomes a lie after the crypto rework: an archived community's messages will
be ciphertext whose seeds no client keeps, so "recoverable" would mean recovering rows nobody can
read.

**DECIDED 2026-08-18 (the user): it deletes for real, behind an explicit confirmation - typing the
community name.** The durable-delete code has existed since WP-01 (`hardDeleteWorkspace`, seven
tables in dependency order); what is new is turning a reversible control irreversible, so the
confirmation IS the work, not a follow-up to it. **Now item 5 of the queue in `CLAUDE.md`** - this
entry stays only until it ships.

### P3 - two communities may carry the same name

Only `slug` is unique. Prod holds two "MiTV" and two "Test", and a member reading a list of names
cannot tell which one they are in. This is what made a real user's lost memberships unreadable to
them until the ids were put side by side.

---

## Storage and retention

The server side has a page already - [storage-forecast](infrastructure/storage-forecast.md) - and it
is where any measurement belongs.

### P2 - `channel_messages` gets a one-year window, and the Graine seeds get the SAME one

Deferred on purpose when the community rework shipped (2026-08-18), not forgotten. Community
messages are kept for ever today; the decision is a **one-year** window, and **the storage cost is
measured on [storage-forecast](infrastructure/storage-forecast.md) BEFORE the sweep is written** -
a sweep sized against a guess is how a retention job becomes the thing that has to be undone.

**The seeds must be swept on the same window, in the same work.** A Graine seed opens the messages
of one session; if the messages go and the seed stays, a device keeps the keys to messages that no
longer exist - unbounded, and pure liability. The durable seed store has no cap at all; only the
native mirror is capped. Two windows that are supposed to be one is exactly the shape that drifts,
so it is one item, not two.

### Server - can occupancy be monitored, and will it hold?

**The media half shipped 2026-08-18** and is documented on
[storage-forecast](infrastructure/storage-forecast.md): `/admin/storage` now separates growth (bytes
written per 7-day window) from a retention sweep that has stopped taking anything, and counts
separately the objects no sweep can EVER reach. That last one was not hypothetical -
`purgeExpiredMedia` iterates the metadata index, so an object with no entry is invisible to it for
ever, and 7 such objects (~11 MB) were already measured.

**What is still open is the MLS half.** §5.7's WP-GHOST-1 shape belongs on the same panel: a device
holding memberships with no `key_package`, or more than a few hundred `queued_message` rows. Neither
is measured anywhere today, and neither is a byte count - they are the shapes that precede a byte
count going wrong. Postgres and Redis are still reported as bare totals, with no breakdown by table
or stream and no slope.

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
