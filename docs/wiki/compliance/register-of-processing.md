# Register of processing activities (GDPR Art. 30)

**Status: first version, 2026-10-16**, written from the code and the wiki inventories named in each
row, after the owner's GDPR review of the same day. Items marked **OPEN** are gaps or unverified
facts; each is in [backlog](../backlog.md#p2---gdpr-compliance-the-open-items-of-the-register-2026-10-16)
and in the [DPO dossier](dso-dossier.md). The public face of the Canari rows is the privacy policy
(`frontend/src/routes/legal/privacy/+page.svelte`, <https://canari.emse.fr/legal/privacy>): **a
change to one is a change to the other.**

Related: [dpia-migallery-faces](dpia-migallery-faces.md), [breach-procedure](breach-procedure.md),
[data-subject-requests](data-subject-requests.md), [`SECURITY.md`](../../../SECURITY.md#what-the-server-knows)
(what the Canari server holds in clear, and why).

## 1. Controllers

| Service | Controller | Contact | Note |
| --- | --- | --- | --- |
| Canari, MiConnect, Sky, Le Cercle, Portail-etu | Association Rootz - EMSE, Maison des Eleves, 20 bd Alexandre de Fraissinette, 42100 Saint-Etienne | `bureau@rootz-emse.fr` | Le Cercle's controller is to confirm: the bar is its own association (**OPEN**) |
| MiGallery | Association MiTV | `bureau@mitv.fr` | Rootz operates the infrastructure for MiTV - a processor role with no written agreement yet (**OPEN**) |
| The school (EMSE) | provider of the identity source (CAS) and of the hosting | the school's DPO | **joint controller or provider: the question only the DPO can answer** ([dso-dossier](dso-dossier.md)) |

No representative (Art. 27) is needed: every controller is established in France. No association
here has designated a DPO; the school has one.

## 2. Canari

Data subjects, unless stated: **members** - students, staff and people of the Maison des Eleves who
hold a MiConnect account. Age floor: 15 (the policy; **no age gate in code**, the population is
the school's).

| # | Processing | Purpose | Data | Basis | Retention | Source |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | Account and directory | identify the member, let others find them | `users`: OIDC sub, display/first/last name, promo, formation, campus, cursus, posts (roles), bio, MiConnect uuid, admin flag; no e-mail, no avatar column (avatars served by MiGallery) | 6.1.b | life of the account; deleted at account deletion; re-created by a new sign-in | `apps/core-service/src/users/entities/user.entity.ts` |
| C2 | Sessions | keep the member signed in, detect abuse | `auth_sessions`: token ids, user agent, device id, last IP, dates | 6.1.b / 6.1.f | 7 days idle (`SESSION_TTL_SECONDS`), cascade on user deletion | [sessions](../sessions.md) |
| C3 | Private and group messaging | deliver end-to-end encrypted messages | MLS ciphertext; in clear: members, group name (`dm_groups.name`), sender, device, time, size; devices (`key_package`: device name, OS, app version) | 6.1.b | `queued_message` deleted on ACK, 90 days max; Redis history 90 days, 8000 entries | [chat-delivery](../services/chat-delivery.md), [SECURITY.md](../../../SECURITY.md#what-the-server-knows) |
| C4 | Communities and salons | community discussion | Graine ciphertext; in clear: community/salon names, members, read marks shown to the salon, a deleted message's author and random client id (so a repeated send is not re-posted) | 6.1.b | salon messages 365 days except pinned (`channel-retention.scheduler.ts`); a deleted message's client-id tombstone until its salon or its author's account is deleted; deleted at account erasure, reactions and pins included (`account-erasure.ts`, decision 2026-10-16) | [channel-encryption](../protocols/channel-encryption.md), [read-receipt-privacy](../read-receipt-privacy.md) |
| C5 | Feed: posts, comments, reactions, polls, reels | publish to a chosen audience | `posts` (author, markdown, mentions, media refs, polls; comments and reactions as JSON in the row) | 6.1.b | until deleted; reels 30 days | [posts](../frontend/modules/posts.md), [reels](../services/reels.md) |
| C6 | Media | store attachments | client-encrypted blobs; index: owner, class, size, dates | 6.1.b | `ephemeral` 90 days idle, `chat-reel` 30 days, `reel` with its post, `form-file` 1-30 days (default 7), `archive` and `association` kept (association documents survive the uploader's deletion); UNCLASSIFIED objects (before 2026-10-01, or from older clients) kept for ever - **OPEN** | [media-service](../services/media-service.md) |
| C7 | Push notifications | tell the member a message or an activity arrived | `push_token` (token, platform, locale); payload to FCM/APNs: ciphertext plus **sender and group names in clear**; social pushes: actor name and up to 60 characters of the text | 6.1.b | token deleted at logout (best effort) and at account deletion; 90 days without renewal | `apps/chat-delivery-service/src/services/push-payload.ts`, `apps/social-service/src/push/push-content.ts` |
| C8 | Associations, cotisations, forms, payments | memberships, sign-ups, purchases | `association_members`, `user_tags`, `submissions` (answers, amounts, Lydia request ids; an `email` column the current client leaves empty - older rows to count, OPEN), `form_files` (plaintext, readable by the association), `purchase_records`, `webhook_deliveries` (to Le Cercle) | 6.1.b; accounting 6.1.c | submissions: **no rule (OPEN)**; purchases anonymised at account deletion, kept for accounting; webhook deliveries 30 days | [cotisations](../cotisations.md), [forms](../frontend/modules/forms.md), [payments](../frontend/modules/payments.md) |
| C9 | Legacy cotisations | give pre-Canari cotisants their dues back | `legacy_cotisations`: match key (last name, first name, promo), label, association, source metadata; **about 1400 people, most with no account** | 6.1.f | **no end date (owner decision 2026-10-16; flagged for the DPO)** | [cotisations](../cotisations.md#seeding-from-a-legacy-estate-legacy_cotisations) |
| C10 | Link previews and Safe Browsing | preview a link; warn before an unsafe one | the URL (the server sees links shared in E2E conversations when previewed); full URL to Google Safe Browsing Lookup API when a link is OPENED | 6.1.f | in-process cache: previews TTL, verdicts 30 min (5 min on failure) | [chat-delivery](../services/chat-delivery.md#link-safety-is-its-own-endpoint-deliberately-not-a-field-on-the-preview-wp-safelink-1) |
| C11 | GIF search (KLIPY) | in-app GIF picker | query and a random `klipy_cid` sent by the CLIENT to KLIPY; KLIPY sees the device IP | 6.1.b | KLIPY's | `frontend/src/lib/utils/chat/gifSearch.ts` - **a server proxy with no identifier is decided (owner 2026-10-16) and not built (OPEN)** |
| C12 | Reports, blocks, moderation | enforce the terms of use | `content_reports`, `user_blocks`, `user_moderation` | 6.1.f | handled reports 90 days after handling; pending kept | [moderation-and-blocking](../moderation-and-blocking.md) |
| C13 | Technical logs | security, diagnosis | nginx access log (IP, time, URI with `token=` redacted, UA), container logs | 6.1.f | **policy 90 days max (owner decision); today the container logs are bounded by size and the deploy archive by a COUNT of deploys, not a clock - enforcement in progress (OPEN)** | [logging](../infrastructure/logging.md) |
| C14 | In-app notifications | activity list | `post_notifications` | 6.1.b | 90 days | `forms-reminder.scheduler.ts` |
| C15 | Pre-release (dev) estate | test a version before it ships | **no production row** (owner, 2026-10-16): a generated fictional seed, plus the accounts testers create by signing in and what they post there; the copy of production is deleted from the code, and the copy dev still held is wiped by the owner's `dev-reset` (**OPEN until run**) | 6.1.f | until the next reset | [dev-environment](../infrastructure/dev-environment.md#3-the-data-a-fictional-seed-and-nothing-from-production-owner-2026-10-16) |
| C16 | Device-side storage | run the client | IndexedDB / SQLite (messages, MLS state, outbox encrypted under the PIN-derived device key; the conversation list in clear), cookies `canari_refresh` (HttpOnly, 7 d), `canari_ws_token` (session), `canari_adminer` (admins), preferences, in-app log (redacted, 2 MB) | 6.1.b; ePrivacy: strictly necessary, **except `klipy_cid`, which serves a third party's analytics (OPEN, disappears with the KLIPY proxy)** | on the device | privacy policy section 7 |
| C17 | Bookings of rooms and slots (**built, not yet released**: the booker's routes from WP-B3 and the organiser's from WP-B4 - create, configure and delete a space, its resources and their availability - unshipped) | let members book a room or an appointment run by a person or an association | `booking_spaces` (owner), `booking_resources` (optional linked account), `bookings` (holder id and name, who booked, UTC range, answers to the space's questions, who cancelled), `booking_participants` (id and name, withdrawal), `booking_blocks` (author). **Who reads what** (WP-B3): the organiser everything; a booking's people - holder, participants still in, the account linked to its resource - its names and the private texts; other bookers the names only when the space shows them; answers the organiser alone | 6.1.b | answers purged N days after the slot (1-30, default 7, D18/D23); everything one year after the slot (D19) - both purges built in WP-B6; account deletion: personal spaces deleted with everything under them, **OTHER PEOPLE'S coming bookings there included, hard-deleted with no notice to them** (D27; no notification in v1, D13); the same when an ORGANISER deletes a space (D27: the count is logged, nobody is told); a resource with any booking cannot be deleted (D42); its own coming bookings cancelled, answers purged, ids tombstoned, name snapshots kept until the one-year purge | [bookings-chantier](../bookings-chantier.md#a-deleted-account-2026-10-16-review-of-1963) |
| C18 | Online presence | show whether a person is online, and tell a sender which devices to reach | Redis key `user:online:{userId}:{deviceId}` per connected device, value `true`; **who may read it** (WP-PRESENCE, 2026-10-18): the person, and anyone sharing a live conversation (`dm_group_members`) or a community (`channel_members`) with them - nobody else; global admins see every connected device (`GET /api/admin/presence`). A block does not hide it ([moderation-and-blocking](../moderation-and-blocking.md#what-a-block-does-not-do)) | 6.1.b | **90 s** after the device's last WebSocket pong (`PRESENCE_TTL_SECS`), deleted at once on a clean disconnect; never written to PostgreSQL, so in no database backup | [chat-gateway](../services/chat-gateway.md#who-may-see-whose-presence-wp-presence-2026-10-18) |

**Account deletion** (`DELETE /api/users/me`, Settings > Supprimer mon compte) is immediate and fans
out to every service through core-service's durable erasure queue, retried until each service answers
2xx; what each column gets is asserted against the schema ([account-erasure](../account-erasure.md)).
The bookings tables (C17) are part of social's `ERASURE_STATEMENTS` (`BOOKINGS_ERASURE_STATEMENTS`).

**Recipients and processors**: section 8. **Transfers**: Google, Apple, Cloudflare, KLIPY (section 8).

**Security measures**: end-to-end encryption of message, media and reaction CONTENT (MLS RFC 9420,
Graine); client-side media encryption (AES-256-GCM CEK); local state encrypted under a PIN-derived
key (PBKDF2-SHA256, 310 000 iterations); access token in memory, 1 h; refresh rotation with replay
detection; TLS 1.2+ (measured on the host and on Cloudflare); a web application firewall on the host
(the DSI's); no secret in the repository; the server logs group names as a byte count.

## 3. MiConnect (Authentik)

| # | Processing | Purpose | Data | Subjects | Basis | Retention |
| --- | --- | --- | --- | --- | --- | --- |
| M1 | Single sign-on | authenticate members for the ecosystem's apps | from the CAS: login (`prenom.nom`) and name; declared at enrolment: formation, promo, campus, affiliations (student, school staff, Maison des Eleves, alumni); `cgu_version`, `cgu_accepted_at`; a SYNTHETIC e-mail `username@canari.emse.fr` sent to apps | students, staff, Maison des Eleves (alumni source configured, not live) | 6.1.b (the terms stage records information, not consent) | life of the account; deleted on request |
| M2 | Authentication logs | security | Authentik events and server access log (IP, time, application) | same | 6.1.f | **policy 90 days max; no `event_retention` is set in the blueprints, so Authentik's default applies (OPEN, to measure and set)** |

Sources: `infrastructure/authentik/blueprints/`, [authentik](../infrastructure/authentik.md),
[profiles-and-access](../profiles-and-access.md). Terms text: `frontend/src/routes/legal/miconnect/`
(pending merge, branch `feat/miconnect-terms-of-use`). Recipients: Canari, Sky, MiGallery, Le Cercle,
the archives (Wiki.js, Omeka - [mino-access](../infrastructure/mino-access.md)); the school's CAS is
the source. Backups: `authentik_db.sql.gz`, 14 days (section 7).

## 4. MiGallery (controller MiTV)

| # | Processing | Purpose | Data | Subjects | Basis | Retention |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | Accounts | sign-in, roles, album permissions | `users` (MiConnect sub, names, promo, formation, role, linked Immich person id), sessions (7 days), favourites, album permissions | members | 6.1.b | life of the account |
| G2 | Event photographs | publish the association's photos to members | photographs (Immich, self-hosted) | **everyone photographed, members or not** | 6.1.f (to document) | **indefinite (OPEN: no retention set)** |
| G3 | Face recognition | let a member find photos of themselves | Immich face detection and embeddings over ALL photos; a member links their account by a selfie | members who opted in; **non-members are detected too** | 9.2.a explicit consent for members (collected by another means - the owner must keep the proof); **no basis identified for non-members (OPEN)** | **embeddings not deleted on unlink or account deletion (OPEN)** |
| G4 | Audit log | traceability | `logs` (actor, event, target, IP) | members | 6.1.f | **no purge (OPEN)** |

Full analysis: [dpia-migallery-faces](dpia-migallery-faces.md). Recipients: Immich (self-hosted),
MiConnect; avatars served to Canari, Sky, Portail-etu. Google Fonts is loaded by the page (visitor
IPs to Google - **OPEN**). Backups: database 14 days, Immich database dumps 7 days, offsite copy on
another school VM. Its terms page (`/cgu`, repository `MiGallery`) carries claims to correct (**OPEN**,
listed in the DPIA).

## 5. Sky

| # | Processing | Purpose | Data | Subjects | Basis | Retention |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | Godparent tree | display the ICM parrainage tradition | `people` (names, promo, formation, role, e-mail, last login), `relationships`, `associations` | ICM students, **including people with no account entered by another student** | 6.1.b (account) / 6.1.f (tradition) | life of the entry; sessions 7 days; pending links expire |

Source: repository `Sky`, `database/schema.sql`, its `/confidentialite` page (controller Rootz,
already lists the data, the bases, and a section for people with no account). Backups 14 days.

## 6. Le Cercle and Portail-etu

| # | Processing | Purpose | Data | Subjects | Basis | Retention |
| --- | --- | --- | --- | --- | --- | --- |
| L1 | Bar accounts and ledger | prepaid balance, till, stock, bar shifts | `users` (names, promo, formation, membership, balance), `ledger`, payment ids arriving from Canari, `sessions` (IP, UA) | members, bartenders, legacy accounts | 6.1.b; accounting 6.1.c | sessions 30 days after end; deletion anonymises and keeps the ledger |
| L2 | Leaderboards | the bar's tradition | names and consumption totals | members | 6.1.f (to document) | **who may read them is to be reviewed against minimisation (OPEN)** |
| P1 | Association showcase | publish the associations and their members | names, promo, role, photo (from Canari and MiGallery) | association members | 6.1.f, with an Art. 21 objection and a 30-day takedown | as long as the member is listed |

Le Cercle has **no privacy page** although its code refers to one (**OPEN**). Portail-etu documents
its basis in its own `docs/wiki/data-protection.md`; its legal notice still lacks the publication
director and the host (**OPEN**, owed by a human).

## 7. Cross-cutting: hosting, backups, logs

| Item | Fact | Source |
| --- | --- | --- |
| Hosting | one shared host of the school, administered with the DSI, carrying `canari-prod`, `canari-dev`, Le Cercle, Sky, Portail-etu and Authentik; the DSI issues the TLS certificates and runs the host's security tooling | [estate-migration](../infrastructure/estate-migration.md) |
| Hosting agreement | **none written (OPEN)** - roles, access, incident notice, end of hosting | [dso-dossier](dso-dossier.md) |
| Legacy names | `canari-emse.fr`, `dev.canari-emse.fr`, the archives and MiGallery still pass through Cloudflare (TLS terminated at the edge) | [cloudflare-edge](../infrastructure/cloudflare-edge.md) |
| Database backups | nightly `auth_db` + `authentik_db` dumps, 14 days, local and mirrored to a second school VM; **to be encrypted (owner decision, OPEN)** | [backup](../infrastructure/backup.md) |
| Media backups | restic (encrypted repository), 14 daily / 8 weekly / 6 monthly snapshots: **a deleted blob can survive 6 months**; most blobs are client-encrypted, but `form-file` objects (CVs) and association public assets (logos) are plaintext | `infrastructure/backup/backup-objects.sh` |
| Logs | nginx `canari_redacted` format; json-file 10 MB x 3 per Canari container; deploy archive of the last 10 deploys; host `/var/log` under logrotate; **non-Canari containers unbounded** | [logging](../infrastructure/logging.md), [storage-and-retention](../infrastructure/storage-and-retention.md) |

## 8. Processors and recipients

| Recipient | Role | Data | Location | Safeguard |
| --- | --- | --- | --- | --- |
| The school's DSI | hosting provider / administrator of the shared host | everything at rest on the host | France | **agreement to write (OPEN)** |
| Google Firebase Cloud Messaging | processor | push token, push payload (ciphertext, sender and group names, social excerpt) | USA | **to be confirmed** (Firebase data processing terms; DPF / SCC not documented here) |
| Apple Push Notification service | processor | device token, alert title (sender or group name); the data FCM relays to it | USA | **to be confirmed** |
| Cloudflare | processor (legacy names only) | requests, IPs, payloads outside E2E content | USA / global edge | **to be confirmed** |
| Google Safe Browsing | recipient | URLs of opened links, server IP only | USA | **to be confirmed**; no user identifier sent |
| KLIPY | recipient (client-side today) | GIF queries, random id, device IP | **to be confirmed** | **to be confirmed**; proxy decided |
| Lydia | payment service, separate controller for the payment | payer e-mail, amount, product names | France / EU | its own terms; partnership contract unsigned (backlog) |
| MiGallery (MiTV) | separate controller | avatar requests by user id | France (school host) | ecosystem |
| MiConnect / Authentik | Rootz's own service | profile claims | France (school host) | internal |
| Le Cercle | separate service | balance top-up webhooks (user id, amount, payment id) | France (school host) | internal |
| The host's firewall (operated by the DSI) | the DSI's security tool | IPs of requests | France | **to confirm whether signals leave the host (OPEN)** |

## 9. OPEN items (summary)

1. The school's role (joint controller or provider) and the written hosting agreement with the DSI.
2. Transfer safeguards for Google, Apple, Cloudflare, KLIPY - documented, or the text says "to be confirmed".
3. Log retention 90 days enforced (Canari containers, deploy archive, Authentik `event_retention`, non-Canari containers).
4. Account deletion complete, with retries; the tables listed in section 2.
5. Database backup dumps encrypted.
6. KLIPY through the server, with no identifier; `klipy_cid` removed.
7. Legacy cotisations kept with no end date - the DPO's opinion.
8. The dev estate's full copy of production - REPLACED by a fictional seed in the code (2026-10-16); the owner's one-off wipe of the copy dev still holds closes it.
9. `submissions` retention rule.
10. MiGallery: the DPIA's measures ([dpia-migallery-faces](dpia-migallery-faces.md#6-open-measures)).
11. Le Cercle: controller, privacy page, leaderboard visibility.
12. Portail-etu: legal notice fields.
13. Unclassified media (before 2026-10-01, or from older clients) kept for ever; a `submissions.email` count on production; a restriction flag.
14. A record of each data-subject request ([data-subject-requests](data-subject-requests.md#4-the-request-log)) and of each breach ([breach-procedure](breach-procedure.md#7-the-breach-register-art-335)), kept off the repository.
