# DPIA (AIPD) - MiGallery face recognition

**Status: draft v1, 2026-10-16, for the controller (Association MiTV) and the school's DPO to
validate; facts updated 2026-10-31 to the stored-template design (option C) MiGallery now carries:
lots A1-A7 written, the A7 seed and lot A8 not yet run.** Every assessment the new design changes
is marked **to be re-assessed by the owner**: this update states facts and draws no conclusion.
The mechanism is MiGallery's [face-matching-option-c](https://github.com/emse-students/MiGallery/blob/main/docs/wiki/face-matching-option-c.md), the one reference; this page
does not restate it. A DPIA is required here: face recognition processes biometric data used to identify a
person (Art. 9(1)), on people who include non-members, which meets at least two criteria of the
EDPB / CNIL list (sensitive data, large-scale or systematic processing of people who cannot easily
object, innovative technology). Register rows G2-G3 in
[register-of-processing](register-of-processing.md#4-migallery-controller-mitv).

**This page names no person and describes no unfixed access-control weakness**: where the
assessment found one, it says "to audit" and the details went to the controller off-repository.

## 1. Description of the processing

| Item | Fact | Source |
| --- | --- | --- |
| Controller | Association MiTV (`bureau@mitv.fr`); Rootz operates the infrastructure | MiGallery `/cgu` |
| Service | MiGallery (`gallery.mitv.fr`), a front end and proxy over **Immich**, self-hosted; MiGallery holds no media itself | MiGallery `docs/wiki/immich-proxy.md` |
| Purpose | let a member find the event photographs they appear in ("Mes photos"), and let them share that set with chosen members | MiGallery `docs/wiki/photos-cv.md` |
| Data | event photographs; **the face store** (`data/faces.db`): one embedding per detected face of EVERY photograph (about 600,000), float16 512-d, sealed (AES-256-GCM, a server-held key), with its box; **per consenting member** (`migallery.db`): 3 to 5 sealed reference embeddings, the faces given to them with their band (`auto` at a distance <= 0.5, `suggested` up to 0.62) and their confirm or reject answer, face crops cut for them alone, the consent record (date, terms version, origin); until lot A8, Immich's own faces, persons and embeddings, and the legacy link `users.photos_id` (read by nothing but the seed) | MiGallery `face-matching-option-c.md` sections 1 and 4, `src/lib/db/schema.sql`, `src/lib/db/face-database.ts` |
| Model | buffalo_l, run by Immich's own machine-learning service, which MiGallery reaches over an internal network holding the two containers only; no clustering, no person object | MiGallery `face-matching-option-c.md` (A2, A3) |
| Data subjects | (a) members who opted in; (b) members who did not; (c) **people with no account, photographed at events** - (b) and (c) are in the face store | - |
| How a member opts in | ticks an explicit agreement box in `/parametres`, then takes a selfie: the model service embeds it in memory and it is never stored, neither in MiGallery nor in Immich; a selfie with a second face is refused. Its embedding is the first reference; faces the member confirms add references, up to 5. A member whose account was linked to an Immich person before gets references from that person's faces (lot A7), only while their consent is open | MiGallery `face-matching-option-c.md` (A5, A7) |
| What a member sees | "Mes photos" shows the `auto` faces and the `suggested` faces they confirmed; the `suggested` ones wait on a confirmation screen, with crops served to them alone. Readers of a member's photos: the member, the members they granted, admins, API keys. MiGallery's proxy refuses every Immich person and face call, to everyone | MiGallery `face-matching-option-c.md` (A6), `docs/wiki/photos-cv.md` |
| Where | MiGallery's wiki states that MiGallery and Immich run on the association's own machine, not on the school's shared host; the offsite copy of MiGallery's database per the [register](register-of-processing.md#4-migallery-controller-mitv) | MiGallery `face-matching-option-c.md` (A8 row) |
| Retention | photographs: indefinite (stated by the terms); the face store: as long as the photograph exists, in **no** backup; references, matches, crops: until withdrawal or account deletion, erased synchronously in one transaction (the crops right after its commit); Immich's faces, persons and embeddings: deleted by lot A8, with an encrypted copy of what is deleted kept 30 days, then deleted (owner, 2026-10-31) | MiGallery `/cgu` sections 4-5, `face-matching-option-c.md` |

**What face detection does that consent does not cover.** Every face of every photograph is
detected and its embedding stored in the face store, before and regardless of any opt-in. The
opt-in gives a member references, and only a comparison with references ties a stored face to
anyone: nothing groups the store into persons. So biometric templates exist for members who never
opted in and for non-members. (Before option C, Immich clustered every face into persons and the
opt-in linked a cluster to an account; Immich keeps those clusters until lot A8 deletes them.)

## 2. Legal basis

| Data subjects | Basis | State |
| --- | --- | --- |
| Members who opted in | Art. 9(2)(a), explicit consent | an explicit agreement box on the enrolment screen, linking the terms; each consent recorded in `face_consents` (date, terms version, origin). **Links made before that record (`legacy`) were collected by another means: the controller must keep their proof** |
| Members who did not opt in | none identified | **OPEN** |
| Non-members | none identified; Art. 9(2)(a) cannot apply to people never asked | **OPEN - the main risk of this DPIA** |

## 3. Necessity and proportionality

- **Purpose legitimate, means heavier than the purpose.** Finding one's own photographs needs a
  match against ONE person's template, not a clustering of every face in the archive.
- **Minimisation.** Clustering everyone is not necessary for the stated purpose. Option C removes
  the clustering but keeps a template of every face; a design matching only opted-in members'
  reference faces would process non-members' faces only transiently (detect, compare, discard) -
  option A, set aside by the owner for its latency and compute cost (MiGallery
  `face-matching-option-c.md`, "The price, stated plainly"). **To be re-assessed by the owner.**
- **Retention.** "Indefinite" for photographs is not justified per category. A member's
  references and matches live no longer than their consent; the face store lives as long as the
  photograph. **To be re-assessed by the owner.**
- **Information.** Members are informed by MiGallery's terms, whose face sections describe the
  stored-template design (terms version 2026-10-31); non-members have only that same public page
  (no notice at events, no page addressed to them).
- **Rights.** MiGallery's terms give a non-member one route to object: writing to
  `bureau@mitv.fr`. The face store's rows carry no member and go with their photograph.
- **Processor.** Rootz operates the infrastructure for MiTV with no Art. 28 agreement.

## 4. Risks

| Risk | Source | Likelihood | Severity | Level |
| --- | --- | --- | --- | --- |
The likelihood, severity and level columns are the 2026-10-16 assessment, kept for the record.
The source column states the facts of the stored-template design (2026-10-31); every row whose
facts changed is **to be re-assessed by the owner**.

| Risk | Source (2026-10-31) | Likelihood | Severity | Level |
| --- | --- | --- | --- | --- |
| R1 - biometric templates of non-members processed with no basis and no information | the face store holds a sealed template of every face, non-members included, not grouped into persons; until A8, Immich also clusters every face | certain (by design) | high (Art. 9 data, no control for the person) | 2026-10-16: **HIGH** - **to be re-assessed by the owner** |
| R2 - templates survive withdrawal | withdrawal and account deletion erase the member's references, matches and crops; the face store's templates of their faces stay, with no member and no name, until their photograph goes; Immich's person and its embeddings stay until A8 | certain for the store (by design) | high | 2026-10-16: **HIGH** - **to be re-assessed by the owner** |
| R3 - a member's photo set or face data seen by members it was not shared with | one access rule for a member's photos (the member, members they granted, admins, API keys); crops served to the face's holder only; the proxy refuses every Immich person and face call, admins included (MiGallery A6) | to assess | high | 2026-10-16: to assess - **to be re-assessed by the owner** |
| R4 - a selfie kept after the link | the selfie is embedded in memory and never stored, neither in MiGallery nor in Immich (MiGallery A5) | 2026-10-16: possible | medium | 2026-10-16: medium - **to be re-assessed by the owner** |
| R5 - identification of a person across the whole archive (tracking attendance) | no clustering in MiGallery: a stored face is tied to someone only through a reference of them; Immich's clusters remain until A8, visible to anyone with Immich admin access | possible | high | 2026-10-16: medium - **to be re-assessed by the owner** |
| R6 - breach of the databases or their backups | the face store is sealed under a server-held key and in no backup; references are sealed and in the MiGallery database backups; Immich's database dumps hold its faces until A8 and rotate out after it; A8's encrypted copy is deleted after 30 days | low | high | 2026-10-16: medium - **to be re-assessed by the owner** |
| R7 - inaccurate match attributes a photo to the wrong person | model error; one holder per face (the nearest member); `auto` only at <= 0.5, with 3 references and no close runner-up, otherwise the member confirms; the measured and derived rates are in MiGallery `face-matching-option-c.md` section 2.2, the rate on strangers NOT MEASURED | possible | low-medium | 2026-10-16: low - **to be re-assessed by the owner** |

## 5. Existing measures

- Sign-in through MiConnect only; roles (`admin`, `mitviste`, `user`).
- Immich is self-hosted; MiGallery reaches it with a server-side key, never exposed to the browser.
- A stored face is given to one member at most (the nearest; a partial unique index on `face_matches`).
- Sharing "Mes photos" requires an explicit grant (`photo_access_permissions`).
- Templates sealed with AES-256-GCM, each bound to its member or to its face; `secure_delete` on
  both SQLite files, so a deleted row is overwritten in the file.
- The model service is reached over an internal network holding MiGallery and that service only.
- The consent record (`face_consents`): date, terms version, origin.
- Backups: MiGallery database 10 daily copies and about 14 days offsite, Immich database dumps 7
  days; the face store in none.

## 6. OPEN measures

Ordered by the risk they lower. Each is a backlog line
([backlog](../backlog.md#p2---gdpr-compliance-the-open-items-of-the-register-2026-10-16)).

1. **R1 - DECIDED 2026-10-24, option C (the owner, for the controller); BUILT as a
   stored-template design** (lots A1-A7 written by 2026-10-31; the A7 seed and lot A8 not yet run).
   What was built differs from the 2026-10-24 text below on three points, decided since: the
   matches are stored (`face_matches`) rather than computed at search time; the model is Immich's
   own machine-learning service, over a dedicated internal network, rather than a pinned image in a
   MiGallery worker; and the model comparison is done (buffalo_l kept). As decided on 2026-10-24: face
   recognition leaves Immich: MiGallery computes, per photograph, the embeddings of the faces it
   contains, in its own worker through a pinned machine-learning image, and stores them in its OWN
   encrypted store (not in Immich). **No clustering and no "person" object**: a member's photographs
   are found by matching their own reference against the per-photo store at the time of the search.
   The embeddings live as long as the photograph exists and are **excluded from backups** (they are
   recomputed from the photograph). **No work package is written before a comparison of the
   candidate models** (accuracy on the archive, and what each computes). The owner takes
   responsibility for the Art. 9 question this leaves: the embeddings of non-members are still
   computed and kept while their photograph exists, but they are never grouped into an identity, so
   no one can be followed across the archive without a reference of them. Until it is built, inform
   at events (a notice where photographs are taken) and publish a page for non-members with an
   objection channel (`bureau@mitv.fr`).
2. **R2 - BUILT** (MiGallery A1, A4, A5): withdrawal and account deletion delete the member's
   references and matches in one transaction, and their crops after its commit. **Owed**: lot A8,
   which deletes Immich's own faces, persons and embeddings and keeps an encrypted copy of what it
   deletes for 30 days, then deletes it (owner, 2026-10-31: *"Oui, 30 jours puis supprimée"*).
3. **R3 - BUILT** (MiGallery A6): one access rule for a member's photos, crops for their holder
   only, every Immich person and face call refused by the proxy to everyone. Whether that closes
   the audit is **to be re-assessed by the owner**.
4. **R4 - BUILT** (MiGallery A5): the selfie is never stored, neither as an asset nor anywhere else.
5. **Proof of consent - BUILT** for the consents given in MiGallery (`face_consents`: date, terms
   version, origin); the controller keeps the proof of the `legacy` links.
6. **Terms page** - MiGallery's `/cgu`: sign-in is MiConnect; the "last updated" date is the terms
   version, a fixed date; the face sections (the store, the selfie, the bands, withdrawal,
   retention, backups, the cutover) describe the stored-template design since lot A9 (terms
   version 2026-10-31). **Still open**: Google Fonts is loaded (visitor IPs to Google) - self-host
   the font.
7. **Processor agreement** between MiTV and Rootz (Art. 28).
8. **Retention** for photographs and for the `logs` table.

## 7. Residual risk and decision

**The assessment of this section predates the build: the residual risk of the stored-template
design is to be re-assessed by the owner.** As written on 2026-10-16 and 2026-10-24: with measures
1 to 3 applied, the residual risk is **medium** (R5, R6). Without measure 1, R1 stays
**high**, and Art. 36 then requires consulting the CNIL before continuing the processing as it is.
**Measure 1 is decided as option C (2026-10-24) and waits for the model comparison before any
build**; option C removes clustering (R1's identity grouping, R5's tracking) but not the computation
of non-members' embeddings, which the owner accepts for the controller. The DPO's opinion is still
asked ([dso-dossier](dso-dossier.md)).

| Date | Who (role) | Decision |
| --- | --- | --- |
| 2026-10-16 | Rootz (author of the draft) | draft written |
| 2026-10-24 | the owner, for the controller | measure 1 = option C: a per-photo embedding store in MiGallery's own encrypted store, no clustering, no persons, kept as long as the photograph, out of backups; no build before the model comparison; the Art. 9 question accepted |
| 2026-10-31 | the owner, for the controller | the build and the cutover go ahead before the DPO's answer: *"Je prends la responsabilité en attendant le DPO, on fait tout jusqu'au bout."*; A8's encrypted copy of what it deletes is kept 30 days, then deleted |
| - | the school's DPO | opinion to give |
