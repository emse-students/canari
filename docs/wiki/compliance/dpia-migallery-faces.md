# DPIA (AIPD) - MiGallery face recognition

**Status: draft v1, 2026-10-16, for the controller (Association MiTV) and the school's DPO to
validate.** A DPIA is required here: face recognition processes biometric data used to identify a
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
| Data | event photographs; face detections, face crops and embeddings computed by Immich's machine-learning component; the link between an Immich "person" and a MiGallery account (`users.photos_id`); the selfie used to make that link | MiGallery `src/lib/db/schema.sql`, `src/routes/api/users/me/face/+server.ts` |
| Data subjects | (a) members who opted in; (b) members who did not; (c) **people with no account, photographed at events** | - |
| How a member opts in | uploads a selfie in `/parametres`; if exactly one face is found, their account is linked to that Immich person; the selfie is then deleted by the browser | MiGallery `src/routes/parametres/+page.svelte` |
| Where | the school's infrastructure (the Immich host), administered with the DSI; offsite copy of the databases on another school VM | [register](register-of-processing.md#7-cross-cutting-hosting-backups-logs) |
| Retention | photographs: indefinite (stated by the terms); embeddings: until the Immich person is deleted | MiGallery `/cgu` |

**What face detection does that consent does not cover.** Immich detects and clusters faces on
EVERY photograph it ingests, before and regardless of any opt-in. The opt-in only LINKS a cluster
to an account. So biometric templates exist for members who never opted in and for non-members.

## 2. Legal basis

| Data subjects | Basis | State |
| --- | --- | --- |
| Members who opted in | Art. 9(2)(a), explicit consent | **collected by another means than the code** (the selfie upload is the act; the consent wording and its record are outside the repository) - **the controller must keep the proof of each consent** (who, when, which text) and be able to show it |
| Members who did not opt in | none identified | **OPEN** |
| Non-members | none identified; Art. 9(2)(a) cannot apply to people never asked | **OPEN - the main risk of this DPIA** |

## 3. Necessity and proportionality

- **Purpose legitimate, means heavier than the purpose.** Finding one's own photographs needs a
  match against ONE person's template, not a clustering of every face in the archive.
- **Minimisation.** Clustering everyone is not necessary for the stated purpose. Immich can run
  with facial recognition disabled, or be restricted; a design matching only opted-in members'
  reference faces would process non-members' faces only transiently (detect, compare, discard).
- **Retention.** "Indefinite" for photographs is not justified per category; embeddings should
  live no longer than the consent that justifies them.
- **Information.** Members are informed by MiGallery's terms; non-members are not informed at all
  (no notice at events, no page addressed to them).
- **Rights.** A non-member has no way to object or to have their face cluster deleted.
- **Processor.** Rootz operates the infrastructure for MiTV with no Art. 28 agreement.

## 4. Risks

| Risk | Source | Likelihood | Severity | Level |
| --- | --- | --- | --- | --- |
| R1 - biometric templates of non-members processed with no basis and no information | Immich clusters every face | certain (by design) | high (Art. 9 data, no control for the person) | **HIGH** |
| R2 - templates survive withdrawal | unlinking or deleting an account clears the link only; the Immich person and its embeddings remain | certain (by design) | high | **HIGH** |
| R3 - a member's photo set or face data seen by members it was not shared with | access control on person and face data **to audit** | to assess | high | **to assess** |
| R4 - a selfie kept after the link | its deletion is done by the browser only; a closed tab leaves it | possible | medium | medium |
| R5 - identification of a person across the whole archive (tracking attendance) | any clustering view | possible for anyone with Immich admin access | high | medium |
| R6 - breach of the Immich database or its backups | shared host, offsite copy | low | high | medium |
| R7 - inaccurate match attributes a photo to the wrong person | ML error | possible | low-medium | low |

## 5. Existing measures

- Sign-in through MiConnect only; roles (`admin`, `mitviste`, `user`).
- Immich is self-hosted; MiGallery reaches it with a server-side key, never exposed to the browser.
- A face can be linked to one account only (`face_already_assigned`).
- Sharing "Mes photos" requires an explicit grant (`photo_access_permissions`).
- Backups: MiGallery database 14 days, Immich database dumps 7 days.

## 6. OPEN measures

Ordered by the risk they lower. Each is a backlog line
([backlog](../backlog.md#p2---gdpr-compliance-the-open-items-of-the-register-2026-10-16)).

1. **R1 - DECIDED 2026-10-24, option C (the owner, for the controller), not built.** Face
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
2. **R2** - unlinking and account deletion delete the member's reference; under option C there is
   no person to delete, and Immich's own faces, persons and embeddings are deleted when recognition
   leaves it.
3. **R3** - audit who can read person and face data through MiGallery's routes and its Immich
   proxy; restrict to the person concerned and to whom they granted.
4. **R4** - delete the selfie server-side (or never store it as an asset).
5. **Proof of consent** - the controller keeps, per member, the consent text version and date.
6. **Terms page** - correct MiGallery's `/cgu`: sign-in is MiConnect (not the school's CAS
   directly); the selfie deletion is immediate in the browser, not "within 24 h" server-side;
   withdrawal does not yet delete the template; the "last updated" date must be a fixed date, not
   today's; Google Fonts is loaded (visitor IPs to Google) - self-host the font.
7. **Processor agreement** between MiTV and Rootz (Art. 28).
8. **Retention** for photographs and for the `logs` table.

## 7. Residual risk and decision

With measures 1 to 3 applied, the residual risk is **medium** (R5, R6). Without measure 1, R1 stays
**high**, and Art. 36 then requires consulting the CNIL before continuing the processing as it is.
**Measure 1 is decided as option C (2026-10-24) and waits for the model comparison before any
build**; option C removes clustering (R1's identity grouping, R5's tracking) but not the computation
of non-members' embeddings, which the owner accepts for the controller. The DPO's opinion is still
asked ([dso-dossier](dso-dossier.md)).

| Date | Who (role) | Decision |
| --- | --- | --- |
| 2026-10-16 | Rootz (author of the draft) | draft written |
| 2026-10-24 | the owner, for the controller | measure 1 = option C: a per-photo embedding store in MiGallery's own encrypted store, no clustering, no persons, kept as long as the photograph, out of backups; no build before the model comparison; the Art. 9 question accepted |
| - | the school's DPO | opinion to give |
