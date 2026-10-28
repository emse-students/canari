# Data-subject requests - the manual procedure

**Decided by the owner, 2026-10-16: access, export (portability), erasure and objection are
answered by hand, by e-mail, within 30 days.** No self-service export exists; account deletion is
self-service in Canari (Paramètres > Supprimer mon compte). The public text is section 10 of the
privacy policy (`frontend/src/routes/legal/privacy/+page.svelte`). Related:
[register-of-processing](register-of-processing.md) (what exists, per service),
[breach-procedure](breach-procedure.md).

## 1. Intake and the clock

| Step | What | When |
| --- | --- | --- |
| 1 | A request reaches `bureau@rootz-emse.fr` (MiGallery: `bureau@mitv.fr`), or any member of the bureau, in any form - no wording is required of the person | day 0 = the day it is received |
| 2 | Open a line in the request log (section 4) | day 0 |
| 3 | **Verify identity** proportionately: a request from the school address `prenom.nom@...` matching the MiConnect login is enough; otherwise ask the person to confirm from inside Canari (a message to the association's account) or from the school address. Never ask for an ID document by default | day 0-3; the clock is suspended while waiting for the answer |
| 4 | Execute (section 3) | before day 30 |
| 5 | Answer by e-mail; for an export, attach the JSON (or a link that expires) | **day 30 at the latest** |
| 6 | If the request is complex or numerous: tell the person before day 30 that up to two more months are needed, and why (Art. 12(3)) | before day 30 |
| 7 | Close the log line | on answering |

A refusal (manifestly unfounded or excessive request, Art. 12(5)) is written, reasoned, and names
the CNIL and the courts as remedies. Free of charge in every case.

## 2. What each right means here

| Right | What is done | Limits to state in the answer |
| --- | --- | --- |
| Access (Art. 15) | the export below, plus the information of Art. 15(1): purposes, categories, recipients, retention, source (MiConnect, the CAS), rights | message CONTENT is end-to-end encrypted: the server holds only ciphertext; the person reads and backs it up on their own devices (Paramètres > Sauvegarde) |
| Portability (Art. 20) | the same export, JSON | only data the person provided, processed on 6.1.b |
| Rectification (Art. 16) | MiConnect profile (formation, promo, campus) via the MiConnect editor or the in-app correction request; name: at the source (the school's CAS) | - |
| Erasure (Art. 17) | Canari: the person deletes the account in the app, or the admin performs the same deletion (the account's `DELETE /api/users/me` fan-out); other services below | backups keep deleted data 14 days (databases) and up to 6 months (client-encrypted media); accounting rows are kept detached from the account; a new sign-in re-creates an account |
| Objection (Art. 21) | stop the processing based on 6.1.f for that person: e.g. delete their `legacy_cotisations` row, remove them from the Portail-etu showcase (30 days), hide them in Sky | the controller may refuse only on compelling legitimate grounds, written |
| Restriction (Art. 18) | freeze the account: no processing other than storage (today by hand: a moderation mute stops posting, the rest is a written commitment) | no restriction flag exists in code (OPEN) |

## 3. Per-service extraction

**Read-only queries, no secrets here.** How to reach each database from a workstation, and the
quoting rules, are in [databases](../infrastructure/databases.md#reaching-it-from-a-workstation).
Run every `SELECT` with the person's id bound as a variable (`psql -v uid=...` then `:'uid'`), and
export with `\copy (...) to 'file.csv' csv header` or `json_agg`. Production reads are free;
**any write or deletion on production waits for the owner's yes** (`CLAUDE.md`, release authority).

### Canari (`auth_db`, PostgreSQL)

The id is the OIDC sub (`users.id`). Find it: `SELECT id, "firstName", "lastName", promo FROM users
WHERE "lastName" ILIKE :'last' AND "firstName" ILIKE :'first';`

| Group | Tables and the column naming the person |
| --- | --- |
| Profile | `users` (`id`), `profile_changes` (`userId`, `actorId`), `profile_correction_requests` (`userId`), `platform_announcement_seen` (`userId`) |
| Sessions and devices | `auth_sessions` (`userId`), `session_push_endings` (`userId`), `device_revoked_sessions` (`userId`), `key_package`, `one_time_key_package`, `device_signature_key`, `push_token`, `pin_verifier`, `revoked_device`, `notification_preference` (all `userId`) |
| Messaging (metadata only; content is ciphertext) | `dm_group_members`, `dm_group_membership_intervals`, `dm_device_group_memberships`, `dm_user_dismissed_groups` (`userId`); `queued_message` (`senderId`, `recipientId`); group names via `dm_groups` joined on the person's memberships |
| Communities | `channel_members` (`userId`), `channel_messages` (`authorId`; content is ciphertext) |
| Feed | `posts` (`authorId`; comments and reactions are JSON inside `posts` - search `comments`/`reactions` for the id), `post_notifications` (`recipientId`, `actorId`), `post_republications` |
| Associations | `association_members`, `association_role_history`, `association_push_mutes`, `user_tags`, `document_reviewer_grants` (`userId`); `association_follows`, `user_follows` (`followerUserId`, `followedUserId`); `association_calendar_events` (`createdBy`) |
| Forms and payments | `submissions`, `form_respondents`, `form_reminders`, `purchase_records`, `webhook_deliveries`, `product_checkouts` (`userId`); `purchase_record_closings` (`closedByUserId`); `form_files` (`uploaderId`); `forms` (`ownerId`) |
| Moderation | `content_reports` (`reporterId`, `reportedUserId`), `user_blocks` (`blockerId`, `blockedId`), `user_moderation` (`userId`) |
| Legacy | `legacy_cotisations` (`claimedByUserId`, or the match key (last name, first name, promo) for a person with no account) |
| Games | `minesweeper_scores`, `minesweeper_challenges`, `minesweeper_bans` (`userId`) |
| Media index | media-service metadata, by `ownerId` (`GET /api/mls/admin/storage` for totals; the blobs are ciphertext) |

Check the column names against the entity before running: the entity files are under
`apps/*/src/**/entities/`, and an unnamed `@Entity()` takes the snake_case of its class
(`push_token`, `key_package`).

### MiConnect (Authentik)

The admin interface (`/if/admin/`, Directory > Users) shows the user's attributes (formation,
promo, campus, affiliations, `cgu_version`, `cgu_accepted_at`) and their events; the same through
the API `GET /api/v3/core/users/?username=<login>` with an admin token. Erasure: delete the user in
the admin interface - the person then cannot sign in to any service.

### MiGallery (SQLite `data/migallery.db`, controller MiTV)

`users` (`id_user`), `user_favorites` (`user_id`), `photo_access_permissions` (`owner_id`,
`authorized_id`), `album_permissions`, `sessions` (`id_user`), `logs` (`actor`). The face link is
`users.photos_id`; the face data itself is in Immich (person, faces) - access and erasure there go
through the Immich admin, see [dpia-migallery-faces](dpia-migallery-faces.md#6-open-measures).

### Sky (SQLite)

`people` (`auth_sub`, or by name for an entry with no account), `relationships` (`source`,
`target`), `associations` (`person_id`), `sessions`, `pending_links`.

### Le Cercle (database of the `le-cercle` repository)

`users` (`uuid`), `ledger` (`uuid_user`, `uuid_staff`), `canari_ledger_details`,
`perm_bartenders`, `sessions` (`uuid_user`). Erasure anonymises the account and keeps the ledger
(accounting).

### Audio calls (register C21)

**An export will not contain call metadata**: it exists only in Redis (room binding 60 s ring + 4 h, presence 2 h, deleted at hang-up) and in the technical logs (90 days at most, C13), never in a database table. Tell the person so in the answer, and search the logs for their user id only if the request names calls specifically. The call lines in a conversation (time, duration) are end-to-end encrypted messages and follow C3.

### Portail-etu

No database: it shows what Canari's public API and MiGallery serve. Objection = remove the person
from the association's roster in Canari, or hide them; takedown within 30 days (its own
`docs/wiki/data-protection.md`).

## 4. The request log

**Kept off the public repository** (it names people). One row per request; keep rows 5 years after
closing, as proof of compliance (a duration we propose, to confirm with the DPO), then delete.

| Field | Content |
| --- | --- |
| Id | `DSR-YYYY-NN` |
| Received | date, channel |
| Person | login or name, how identity was verified |
| Right(s) | access / portability / rectification / erasure / objection / restriction |
| Services | Canari, MiConnect, MiGallery, Sky, Le Cercle, Portail-etu |
| Deadline | received + 30 days (+ extension, with the date the person was told) |
| Actions | what was extracted or deleted, by whom (role) |
| Answered | date, summary of the answer, refusal grounds if any |

## 5. Answer templates (French)

```text
Objet : Votre demande [d'accès / d'effacement / ...] - reçue le [date]

Bonjour,

Nous avons bien reçu votre demande du [date]. [Accès :] Vous trouverez ci-joint, au format JSON,
les données vous concernant que traitent [services]. Le contenu de vos messages privés est chiffré
de bout en bout : il n'est lisible que sur vos appareils, et sa sauvegarde se fait depuis
l'application (Paramètres > Sauvegarde).

[Effacement :] Votre compte et les données associées ont été supprimés le [date]. Certaines
données subsistent dans nos sauvegardes pendant 14 jours au plus (6 mois pour les fichiers,
dans un dépôt chiffré), puis disparaissent ; vos achats restent dans la comptabilité des associations,
détachés de votre compte.

Les finalités, destinataires et durées de conservation sont décrits dans notre politique de
confidentialité : https://canari.emse.fr/legal/privacy. Si vous estimez que vos droits ne sont pas
respectés, vous pouvez saisir la CNIL (www.cnil.fr).

L'association Rootz - EMSE
```

## 6. What is OPEN

- No export tooling: each export is assembled by hand from section 3; a script producing the JSON
  per service would remove the risk of a forgotten table.
- The erasure fan-out is being made complete, with retries (see
  [register](register-of-processing.md#2-canari)); until it ships, an erasure request also needs
  the listed tables checked by hand.
- The off-repository location of the request log is not recorded.
