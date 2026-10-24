# Account restore on a new Android phone (WP-RESTORE-1)

**Status: designed 2026-10-18, built on `feat/restore-1`, NOT in a stable until the user has read it
on a phone** (user, 2026-10-18). Google Play requires it from April 2027; the requirement, the
accepted principle and the three traps are on
[mobile](frontend/mobile.md#wp-restore-1---zero-tap-sign-in-restoration-accepted-2026-08-26-built-2026-10-18)
and are not re-argued here. This page is the design: what is restored, against whom, and by which
piece.

## What is restored - a SESSION, and nothing else

| Restored | Not restored |
| --- | --- |
| A Canari session for the account (an `auth_sessions` row, a refresh credential and a 1 h access token), exactly what the MiConnect callback mints | The MLS device key, `mls.bin`, the message database, Graine seeds, the PIN, the "Rester connecte" vault, the MiConnect session, the MiConnect id_token |

The new phone is then in the state of a phone that has just signed in through MiConnect: it asks
for the PIN, enrols as a NEW MLS device, and receives history from the account's other devices
([backup](frontend/backup.md), [channel-encryption](protocols/channel-encryption.md)). Nothing that
decrypts anything travels. The only difference from a MiConnect sign-in is that no MiConnect
session is opened on the new phone, so its first sign-out is `local-only` for MiConnect - the
ordinary state of a session with no id_token ([auth](frontend/modules/auth.md#signing-out-ends-the-miconnect-session-2026-10-14)).

## Threat model

**What a restore key IS.** A WebAuthn credential created silently by Android's Credential Manager
for the package `fr.emse.canari`, private key held by the platform (never exported to the app or to
us), copied into the user's Google backup end-to-end encrypted with the old phone's screen lock
(`isCloudBackupEnabled = true`), or carried only by a device-to-device transfer when that backup is
unavailable (`false`). The server holds its PUBLIC key only.

**Who can use one.** Someone who can complete a restore of that Google backup onto a phone running
our Play-signed app: the Google account AND the old phone's screen-lock secret, or physical access
to the unlocked old phone. Both already mean the account is lost (an unlocked phone with Canari
running IS the session).

**What one is worth: EXACTLY the session that created it - a restore MOVES that session, it never
adds one.** This is the design's one invariant, and every rule below follows from it:

- **A restore key is bound to the `auth_sessions` row that registered it (`ON DELETE CASCADE`).**
  Whatever ends that session ends the key, through mechanisms that already exist: a sign-out
  (`POST /api/auth/logout`), "remove this device" (`DELETE /api/auth/sessions/:id`), "sign out
  everywhere else", the one-session-per-device purge (`bindDevice`), the 7-day idle expiry swept
  hourly, and account erasure. A key whose session row exists but is past `expiresAt` is refused
  before the sweep reaches it, exactly as a refresh is.
- **A restore is single-use and a TRANSFER.** ONE transaction spends the challenge, deletes the
  key's row (`DELETE ... RETURNING`, so two concurrent assertions cannot both win) AND deletes the
  old session; only then is the new phone's session minted. The account never holds one session
  more than before: a mint that fails after that commit leaves NO session (logged at `error`, the
  new phone signs in through MiConnect, the old one at its next refresh) - never two, which a
  revocation run after the mint could not promise. The new phone registers its own key at its
  first start.
- **So the old phone is signed out by a restore.** Its next refresh meets a missing row and takes
  the ordinary session-expired path. A transfer is the case Play describes (setting up a new phone
  from the old one), and the old phone signing out is the visible trace of it - the same trace a
  stolen-and-used credential leaves.
- **And the old phone stops receiving the account's notifications.** The same transaction records
  the old session's push ending (`session_push_endings`, cause `restored`), drained after the
  commit by `SessionPushEndService` as every other session end is - so a phone restored from and
  then sold keeps no push registration for the account ([sessions](sessions.md), "A session that
  ends takes its device's push registration with it"). The adversarial review of 2026-10-24 found
  the first draft deleting the session row bare, which left that registration alive - and the
  integration case written for it found a worse one under it: TypeORM's postgres driver answers a
  raw `DELETE ... RETURNING` as `[rows, rowCount]`, the draft read it as the rows, so the old
  session was NEVER deleted and a consumed key never read as `gone`. The in-memory fake answered
  the rows alone and hid it; it now answers the driver's shape, and
  `session-push-end.integration.spec.ts` runs `consume` against PostgreSQL.
- **A restore does not refresh the old session** before revoking it, so nothing about the chain
  extends a session's life.

**Why a transfer and not an extra session (adversarial review, 2026-10-18).** With `attestation:
none` the server cannot prove a key lives in Credential Manager: whoever holds an access token AND
the refresh credential can register a SOFTWARE key and write any `clientDataJSON`, our
`android:apk-key-hash` origin included - so origin pinning stops a phishing page, never the holder
of a stolen session. Had a restore ADDED a session, such a key would mint independent sessions,
each surviving the revocation of the parent, with none of the fork detection the refresh rotation
has (`AuthSessionsService.rotate`, `replayed`). As a transfer it buys exactly what the stolen
refresh credential already bought, and it signs the victim out, which the victim sees. Two more
narrowings: **a registration is accepted only from the Android app's own origin**
(`http(s)://tauri.localhost`), so an XSS on the web - which holds an access token and can ride the
cookie - cannot register one (a browser cannot forge `Origin`; a stolen credential replayed from a
script can, and is the residual case above); and every restored session appears in "Connexions
actives" like any other. **`tauri.localhost` is ALSO the origin of Tauri's Windows desktop app**
(WebView2 serves the app from `http://tauri.localhost`), so the gate is "a Canari app", not "the
Android app": a desktop session can register a key too. It buys that session nothing it did not
already hold, by the invariant above, and the platform half (Credential Manager) exists only on
Android, so the desktop client never asks.

**A planted key does not outlive its planter's access (security review, 2026-10-18).** A thief who
copied the refresh credential once could otherwise register a software key and keep it after the
owner's next refresh rotated that credential away - the key would still move the session to the
thief later. Two rules close it:

- **A registration needs the session's CURRENT refresh credential**: the refresh JWT's `jti` must
  equal the row's `tokenId` (`isLiveSessionOf(..., tokenId)`), the value `rotate` moves at every
  refresh - or be the one the last rotation replaced, inside the SAME 60 s grace window a refresh
  grants (`isPreviousTokenInGrace`, one predicate for both). The grace token is accepted because a
  start runs its refresh and this registration side by side, and a refresh already hands that
  token's holder the current one: the window grants nothing the refresh does not. A copy the
  rotation has moved past is answered `404 RESTORE_NO_SESSION` and logged at `warn`.
- **The owner's client re-checks at EVERY start and replaces a key it did not register.** The
  options answer carries `registeredCredentialId`, the key the session holds. The client keeps a
  record of TWO ids: `held`, the key the platform holds (written the instant Credential Manager
  answers a create, before the server is told - Credential Manager has no read short of a signed
  assertion), and `registered`, the key the server last confirmed. The server's key equal to
  `held` is this install's, a registration whose answer was lost included - recorded, never
  accused. Equal to `registered` but not `held`, it is this install's previous key (a create whose
  registration was then refused) - replaced with a `warn`. Anything else is accused at `error` and
  replaced. The registration names `previousCredentialId` (= `registered`); the server logs
  `[RESTORE] replaced a key the client did not name` at `warn` when the key it actually replaced
  is another - a `warn` and not an `error`, because from the server a planted key and an install
  that merely lost its local record look the same, and the line names both readings; the client,
  which holds `held`, is the end that can tell them apart and accuses. So a key planted between two
  of the owner's starts lives until the next one, and leaves a line on both ends - and an honest
  divergence leaves no false accusation.
- **One registration at a time.** `ensureRestoreKey` is single-flight on the client, and two
  registrations racing for one session anyway (two installs of one session cannot exist; two
  requests can) meet the unique session constraint: the second is a typed `409
  RESTORE_REGISTRATION_CONFLICT`, never a 500, and the next start re-checks.

**The cost of that invariant, stated plainly.** A phone that is lost, broken or simply unused for
more than 7 days has an expired session, so its key is gone and the new phone signs in through
MiConnect. Play's requirement is that restore is supported, not that it outlives the session; a key
that outlived its session would be a credential stronger than any login Canari issues, kept for a
period nobody chose. **This is a product trade-off the user may widen later.**

**Not a second sign-in, and MiConnect is not asked.** Decided 2026-08-26 and not re-opened: Google's
API does not handle MFA. A restore consults MiConnect no more than a refresh does: an account
MiConnect has disabled, or whose per-app access (`profile-valid`, [profiles-and-access](profiles-and-access.md))
was withdrawn, keeps a live Canari session until it ends, and a restore moves that session - it does
not create one MiConnect would have refused, and it does not refresh the profile claims
(`parseProfileClaims` runs only on a MiConnect callback). The PIN is a client-side gate on the MLS
state, not a server factor.

**A sign-out that never reached the server leaves the session, and so the key, alive.** The
sign-out revokes under a deadline (`clearAuthUnderway`); past it, the row lives on for its idle
life, and the key's copy in the Google backup with it - clearing the key on the phone does not
reach a backup already taken. This is the SAME residual the refresh row already has (the session
is alive, only this phone forgot it); the restore makes it reachable from a restored phone. Closing
it needs a durable sign-out (a revocation retried until answered), which is filed in the
[backlog](backlog.md#p3---a-sign-out-that-never-reached-the-server-leaves-a-restore-key-alive-in-the-google-backup)
rather than built here.

**Server-side theft.** The tables hold public keys and session ids. A database leak yields nothing
that signs in (unlike a refresh token, which is a bearer secret).

**User presence and verification are not REQUIRED.** A restore key is created and used with no
prompt (that is "zero-tap"); whether Android then sets the UP flag is NOT documented, so the server
accepts both (`requireUserPresence: false` on registration, `advancedFIDOConfig: { userVerification:
'discouraged' }` on assertion - the library's only switch that stops refusing `UP=0`), and the spec
pins that both shapes verify. **The flags a real restore key carries are owed as a device reading**;
if it sets UP, the server is tightened to require it. What protects the assertion is the signature,
the single-use challenge, and the transfer.

**What the WebAuthn `user` names.** `user.id` is 32 random bytes per key and `user.name` /
`displayName` are the constant `Canari`: nothing in the user's Google backup identifies them.

## The server - `core-service`, `/api/auth/restore/*`

Library: `@simplewebauthn/server` (CommonJS build, no native code). The design adds no state an
anonymous caller can grow (below), and the four routes are throttled all the same
(`@nestjs/throttler`), each by the bucket that fits its caller:

- **The two registration routes, 10 a minute per ACCOUNT** (`AccountThrottlerGuard`, keyed on the
  subject of a VERIFIED access token, so nobody picks another account's bucket). Every Android start
  calls them, and a campus behind one NAT address would otherwise share one bucket.
- **The two anonymous routes, 120 a minute per visitor ADDRESS** (`ClientIpThrottlerGuard`, the
  `X-Real-IP` nginx writes - the shape chat-delivery and social-service already use - never the
  nginx container every request arrives from). The ceiling is sized for a burst of fresh installs
  behind one campus address, and the client reads a 429 as "cannot answer now", never as a verdict
  (below), so a throttle never turns restore off on an install.

| Method, path | Auth | Does |
| --- | --- | --- |
| `POST /api/auth/restore/registration/options` | Bearer + refresh credential (cookie or `X-Canari-Refresh`), AND `Origin` one of the Android app's (`http(s)://tauri.localhost`) | `{ options, registeredCredentialId }`: creation options for THIS session (challenge, RP id, a random `user.id`, ES256/RS256, `attestation: none`, `residentKey: required`, `userVerification: discouraged`) and the id of the key the session holds now, or null |
| `POST /api/auth/restore/registration` | same | Verifies the registration response; stores THE key of this session (one per session, a re-registration replaces it; a credential id already held by ANOTHER session is refused, never re-bound); answers `{ registered: true, credentialId }` and warns of a replaced key that is not the body's `previousCredentialId` |
| `POST /api/auth/restore/assertion/options` | none | Request options: a challenge, the RP id, `userVerification: discouraged`, no `allowCredentials` (the platform chooses) |
| `POST /api/auth/restore/assertion` | none | Verifies the assertion against the stored public key and the bound session's life (writes nothing); refuses an erasure or a maintenance window HERE, so the key survives a refusal and can be retried; then consumes the key, the challenge and the old session in one transaction; then mints the new phone's session through the callback's own minting |

**The session is identified the way `PUT sessions/current/device` identifies it**: the access
token names the user, the refresh credential names the row, and the row must exist, belong to that
user, be unexpired - and, for these routes, still carry the refresh credential's `jti` as its
current one (the planted-key rule above).

**Challenges are STATELESS until they are spent, so an anonymous caller writes nothing.** A
challenge is `nonce(16) || expiry(8) || HMAC-SHA256(key, purpose || binding || nonce || expiry)`,
base64url. The key is derived from `JWT_SECRET` with a domain label (`canari-restore-challenge-v1`),
so it can never verify as any other token kind. `binding` is the session id for a registration and
empty for an assertion. A challenge is valid for 300 s - a validity bound of a security token like
the JWT `exp`, not a retry timer. **Single use:** only an assertion whose SIGNATURE verified writes
its nonce into `restore_challenges_spent` (`INSERT ... ON CONFLICT DO NOTHING`); zero rows inserted
is a replay and is refused. And the key itself is consumed in that transaction, so the nonce is a
second lock, not the only one. The spent rows have their own hourly sweep
(`RestoreCredentialsService.deleteExpiredSpent`). A registration needs no spent record: replaying it
re-writes the same key for the same session.

**Minting is ONE function shared with the MiConnect callback** (`issueSession`, extracted from
`oidcCallback` from the point where the account is known - the MiConnect half, the code exchange,
`findOrCreateFromOidc` and the profile claims, stays in the callback): the erasure refusal before and after (`refuseDuringErasure`,
`confirmAfterSignIn`), the maintenance gate, the access token, the session row, the cookie for
everyone and the body copy for the clients that carry their own. Two copies of that sequence would
drift, and the erasure race is exactly the part that must not.

**Refusals are CODES, classified at the throw** (the client branches on the code, never on prose):

| Status, code | Meaning | Client does |
| --- | --- | --- |
| 401 `RESTORE_KEY_UNKNOWN` | no key with that id, or its session is gone or expired | clears the local key, shows the ordinary sign-in |
| 401 `RESTORE_ASSERTION_INVALID` | signature, origin, RP id, challenge or replay refused | logs at `error` (a key we registered failed to verify: a defect), shows the ordinary sign-in |
| 503 `RESTORE_UNAVAILABLE` | this estate has no signing fingerprint configured | logs, shows the ordinary sign-in, keeps the key |
| 429, 408 | throttled, or too slow to answer | as `RESTORE_UNAVAILABLE`: the attempt stays un-recorded and the next start asks again |
| 409 `RESTORE_REGISTRATION_CONFLICT` (registration) | another registration for this session committed first | the start's registration fails, logged; the next start re-checks |
| 403 `ACCOUNT_ERASURE_*`, 503 `MAINTENANCE` | as for a MiConnect sign-in | the same sentences as a MiConnect sign-in |

Every refusal is logged server-side at `warn` with the code and the first 8 characters of the
credential id; a success at `log` with the user and the new session id.

**`UNKNOWN` versus `INVALID` tells an anonymous caller whether a credential id exists**, because the
id is looked up before the signature is checked. That is harmless and kept: an id is 16+ random
bytes nobody can enumerate, knowing one exists signs nothing in, and the distinction is what lets
the client clear a dead key without accusing a defect.

**Configuration - one fact, already a GitHub secret, newly delivered to core-service.** The expected origins are
`android:apk-key-hash:<base64url(SHA-256 of the signing certificate)>` for each fingerprint in
`ANDROID_APP_LINK_SHA256` - the SAME value the frontend build writes into
`/.well-known/assetlinks.json` (`buildAssetLinksJson`, which already declares
`delegate_permission/common.get_login_creds`), so the two cannot name different certificates. The RP
id is the hostname of the first entry of `FRONTEND_URL` (the canonical name: `canari.emse.fr` on
production, `dev.canari-emse.fr` on dev). **An empty fingerprint list fails CLOSED**: the four
routes answer 503 and the boot logs one `error` line, rather than accepting any origin. Until this
work the secret reached only the frontend BUILD (`build.yml`); it now has a row in
`infrastructure/deploy/env-manifest.tsv` (`warn` on both estates: absent, restore is unavailable),
is passed by `serve-prod.yml` / `serve-dev.yml`, and is wired into `core-service` in both compose
files. Dev reads `DEV_ANDROID_APP_LINK_SHA256`, which does not exist yet - **a one-off for the user**
(the same value as production's: one Play signing key signs both tracks). The conversion is
`base64url` WITHOUT padding of the 32 bytes the colon-hex names, accepted in exactly the forms
`parseAndroidSha256Fingerprints` accepts.

**The RP id is permanent for a key, so it is named once and never reordered.** It is the host of
`FRONTEND_URL`, which render-env documents as the canonical name alone. A host move orphans every
key - the platform then offers none for the new RP id, the attempt answers "nothing to restore", and
the phone signs in through MiConnect; nothing is logged as a defect. A pre-release APK talking to
dev holds a key for `dev.canari-emse.fr`, which a production server never asks for, so the same.

### Schema - migration `013_restore_credentials.sql`

```
restore_credentials
  id            TEXT PK          -- the credential id, base64url, as the platform names it
  "userId"      VARCHAR(255)     -- FK users(id) ON DELETE CASCADE
  "sessionId"   UUID UNIQUE      -- FK auth_sessions(id) ON DELETE CASCADE: the invariant
  "publicKey"   BYTEA            -- COSE public key
  counter       BIGINT           -- signature counter (single use makes a diverging clone counter moot)
  "cloudBackup" BOOLEAN          -- what the phone did: true = Google backup, false = the E2eeUnavailable second path
  "createdAt"   TIMESTAMPTZ
restore_challenges_spent
  nonce         TEXT PK, "expiresAt" TIMESTAMPTZ   -- no account id
```

Idempotent (`IF NOT EXISTS`, constraints added in a `DO` block as 003 does). `userId` is
redundant with the session's, and kept on purpose: it is the account-id column the erasure deletes
by name (`CORE_ERASURE_STATEMENTS`, before `auth_sessions`), so the erasure does not depend on a
cascade it cannot see, and the integration spec's "no row still names the id" covers it.

**`cloudBackup` is the measurement the second path owes.** The backlog's trap (3) requires the
`isCloudBackupEnabled = false` retry to be logged at a level that accuses AND measured against the
population: `SELECT "cloudBackup", count(*) FROM restore_credentials GROUP BY 1` is that measurement.

## The client

**Two modules, Android only** (`isAndroidTauriRuntime`; every other platform is a no-op that says
why: the Restore Credentials API exists only on Android, Play is the only store that requires it,
and iOS restores through iCloud Keychain, a different product nobody asked for).
`frontend/src/lib/services/restoreKey.ts` holds the native calls and the two local markers, and
imports nothing of the auth store, so `auth.ts` can clear the key and drop the markers;
`restoreCredential.ts` holds the two flows and imports the auth store. The command names are pinned
against the Rust and Kotlin sources by `restoreCommands.test.ts`.

- **Register** (`ensureRestoreKey`, single-flight) - in `loginImpl` beside
  `bindCurrentSessionDevice`, at EVERY app start while online. It asks the options, which name the
  key the session holds, and compares it with the `{ held, registered }` record this install keeps
  under `canari_restore_registered:<userId>`; when the server holds the platform's key it stops
  there (one request, no platform call). Otherwise it registers, after the reading the planted-key
  rule above describes (accused at `error` only when the key is nobody's here). So an existing user gets a key at the first start
  of the new version, without signing in again. Fire-and-forget, every failure logged; a failure
  leaves the marker unset and the next start tries again. **A key is per SESSION and the marker is per account, so the marker is dropped at every
  session MINT** (`adoptSignedInSession`: every MiConnect callback and every restore), never only on
  the sign-out paths - one of which (`loginImpl`'s session-expired branch with no callback wired)
  forgets the user without `clearAuth`. A restored phone therefore registers its own key at its
  first start, replacing on the platform the consumed one it arrived with. Offline, the login skips
  it and `promoteOfflineSession` runs it once a token exists, exactly as the device binding.
- **Attempt** - on `/login`, when no session exists, on the FIRST START OF A FRESH INSTALL only:
  `canari_restore_attempted` is written by the attempt's answer AND by every sign-in and every
  sign-out, so a phone that was ever signed in never asks again. That is what keeps a key whose
  sign-out never reached the server (the residual above) from signing its owner straight back in
  on the same phone. localStorage is not in the Android backup, so a restored phone starts without
  the marker. The marker is written only on an ANSWER: no key on this phone, a server verdict on the
  key, a platform failure. A transport failure, `RESTORE_UNAVAILABLE`, `MAINTENANCE`, a 408, a 429
  and any 5xx leave it unset - none of them is a verdict on the key. While it runs the sign-in button says
  `auth_restore_in_progress`. On success the response is adopted by the SAME code that adopts the
  MiConnect callback's (`adoptSignedInSession`, extracted from `handleOidcCallbackUnderway`, counted
  as a sign-in in flight), then the app goes where a sign-in from `/login` goes.
- **Clear** - in `clearAuthUnderway`, the single funnel of every sign-out (chosen, session expired,
  device revoked, identity split, account deletion), with the marker; and in `loginImpl`'s
  session-expired branch, which forgets the user without that funnel when no callback is wired
  (Google: clear on a server 401 too). **Not in `clearAuthLocally`**, deliberately: that path is a
  web tab told by ANOTHER tab that its account was deleted, it touches nothing shared by design, and
  the key, like the cookie, is one per app - the deleting tab's own `clearAuth` already cleared it.
  Best effort and logged: when the sign-out reached the server, its cascade has already made the
  key worthless, which is why "do not rely on client-side deletion" holds (when it did not, see the
  residual in the threat model).

**Paraglide** (`fr.json` / `en.json`): `auth_restore_in_progress` - "Restauration de votre
session..." / "Restoring your session...". No other user-visible string: every failure ends on the
ordinary sign-in screen, whose button already speaks; a refusal that has a sentence (erasure,
maintenance) reuses the MiConnect sign-in's.

## The native piece - `tauri-plugin-restore`

`frontend/src-tauri/plugins/tauri-plugin-restore`, shaped like `tauri-plugin-customtabs`: three
commands, `create_restore_credential(requestJson) -> { responseJson, cloudBackup }`,
`get_restore_credential(requestJson) -> { responseJson } | { absent: true }`,
`clear_restore_credential()`. Kotlin uses `androidx.credentials:credentials` and
`credentials-play-services-auth` **1.6.0, the stable line** (trap 2: the feature arrived in
1.5.0-beta01; 1.7.0 is still alpha), through the callback API so no coroutine dependency is added.
`E2eeUnavailableException` is retried once with `isCloudBackupEnabled = false` and logged at `ERROR`
naming the cause (trap 3); `NoCredentialException` on get is the ordinary "nothing to restore" and
returns `absent`. Desktop and iOS return `Unsupported` from Rust with no platform code: a no-op whose
reason is written at the site.

Google's Tier 1 (a `BackupAgent` calling get in `onRestoreFinished`) is NOT used: the app has
`allowBackup` restricted and no agent, and Google states Tier 2 (first launch) alone is the right
shape then.

## Old clients, the floor, and the shims

**Nothing changes for an old client, so there is no floor and no shim.** The four routes are new;
an old client never calls them and holds no key. Every existing route keeps its shape: `issueSession`
is a refactor whose responses the existing `auth.controller.spec.ts` pins. `minClientVersion` is not
touched, and [legacy-compatibility](legacy-compatibility.md) gains no entry.

## GDPR

- **Register, row C2 (Sessions)** gains the restore key: data `restore_credentials` (public key,
  credential id, session id, backup mode, dates), same basis 6.1.b, retention "with the session that
  registered it", source this page.
- **Privacy policy, section 2 "Donnees techniques" and section 8 "Sessions"**: on Android, a
  restore key lets a new phone restored from the Google backup reopen the session without signing in
  again; Canari keeps only its public half, and it disappears with the session. Google is not a
  recipient of anything we send: the key is created and backed up by the phone's own system.
- **Account erasure:** `restore_credentials` by `"userId"` in `CORE_ERASURE_STATEMENTS`;
  `restore_challenges_spent` holds no account id.

## Verified by what

| Claim | Verified by |
| --- | --- |
| Challenge format, expiry, purpose and binding separation, single use | `restore-challenge.spec.ts` (injected clock, no wall clock) |
| Registration and assertion verification, origin pinning, RP id, unknown key, dead session, replay, minting through `issueSession` | `restore-credentials.service.spec.ts`, `restore.controller.spec.ts`, with a software authenticator in the test (real ES256 signatures) |
| A stale refresh credential cannot register, the grace-window one can; a replaced key the client did not name is warned of; a racing registration is a typed 409 | `restore-credentials.service.spec.ts` (rotation moves `tokenId`, the grace window, the unique violation), `restore.controller.spec.ts` (the replaced-key `warn`, `RESTORE_REGISTRATION_CONFLICT`) |
| The old session AND its push ending go in the consume transaction (against PostgreSQL too); erasure and maintenance refuse BEFORE it; a failed mint leaves no session and no cookie | `restore-credentials.service.spec.ts`, `restore.controller.spec.ts` (call order and the mint-failure case), `session-push-end.integration.spec.ts` |
| The registration routes are throttled per account, the anonymous ones per address | `client-ip-throttler.guard.spec.ts` (both trackers, a forged token never picks a bucket, the guard on each route) |
| The cascade and the erasure statement | `erasure-policy.spec.ts`; the cascade by the migration text, and by `account-erasure.integration.spec.ts` where a database is reachable |
| Client attempt / register / clear decisions, the every-start check, the foreign-key replacement, a lost answer recognised, single-flight, a 429 never recording the attempt, the refusal codes | `restoreCredential.test.ts` |
| The JS command names, the ACL, the permission set, the Kotlin method names and argument name | `restoreCommands.test.ts`, which reads the Rust and Kotlin sources |
| The wire shapes the Kotlin side resolves | `cargo test` in `tauri-plugin-restore` (serde, both directions) |
| The env delivery of `ANDROID_APP_LINK_SHA256` to core-service | `deploy-env.test.sh`, `compose-wiring.test.sh` |
| The Rust commands | **compiling only** - `cargo clippy -D warnings` for the host AND `--target aarch64-linux-android` (the iOS target needs `xcrun`, absent on the Windows workstation) |
| The Kotlin plugin (androidx.credentials 1.6.0) | **compiling only, and only in CI** - the Android build (`android.yml`, dispatched on the branch, never published) |
| A real restore: create on phone A, Google backup, restore onto phone B, zero-tap sign-in, the old phone signed out at its next refresh | **owed: a device reading** - the Mi 9T and a second Android phone; the iPhone is not involved |
| The UP and UV flags a real restore key sets | **owed: a device reading** (the server log of a real registration and assertion); if UP is set, the server is tightened to require it |
| The platform REPLACES the consumed key when the new phone registers its own | **owed: a device reading** - a second restore from the new phone's backup must sign in with the NEW key |
| `E2eeUnavailableException` and its second path | **owed: a device reading** on a phone with no screen lock; the rate is `SELECT "cloudBackup", count(*) FROM restore_credentials GROUP BY 1` |
