# Personal data breach procedure (GDPR Art. 33 and 34)

**Scope**: every service of the ecosystem whose controller is the Association Rootz - EMSE (Canari,
MiConnect, Sky, Le Cercle, Portail-etu) and MiGallery, whose controller is MiTV. The register these
breaches are recorded in is at the end of this page. Related:
[register-of-processing](register-of-processing.md), [data-subject-requests](data-subject-requests.md),
[dso-dossier](dso-dossier.md), and the root [`SECURITY.md`](../../../SECURITY.md), which is the
intake channel for an external report of a vulnerability (a vulnerability is not yet a breach; it
becomes one when personal data was actually exposed, altered, lost or made unavailable).

**This page is a runbook. It names roles, never people**: who holds a role is the association's
current bureau, recorded off-repository.

## 1. What counts as a breach

Art. 4(12): a breach of security leading to the accidental or unlawful destruction, loss,
alteration, unauthorised disclosure of, or access to, personal data. Three families, all in scope:

| Family | Examples on this estate |
| --- | --- |
| Confidentiality | a database dump or a backup archive read by someone not entitled to it; an API route answering another user's data; a log line carrying a personal field copied off the host; the dev estate exposed (testers' own accounts; it holds no production row since 2026-10-16) |
| Integrity | rows altered by an attacker or by a faulty migration; a forged session acting as a user |
| Availability | `auth_db` or the media store lost with no restorable backup; ransomware on the shared host |

**What the end-to-end encryption changes.** Message bodies, media and reactions are MLS or Graine
ciphertext the server cannot open ([SECURITY.md](../../../SECURITY.md#what-the-server-knows)). A
leak of those tables alone is still a breach (the metadata in the same table is personal data), but
the CONTENT is unintelligible to the recipient, which is the Art. 34(3)(a) ground for not notifying
data subjects individually - **only if the keys were not exposed too**. The cleartext columns
(names, promo, group names, membership, timings, payment rows, legacy cotisations) are NOT covered by
that ground.

## 2. Detection - where a breach is first seen

| Source | What it shows |
| --- | --- |
| A report under [`SECURITY.md`](../../../SECURITY.md) (GitHub Security Advisory) or an e-mail to `bureau@rootz-emse.fr` | an external finding |
| The daily `scheduled.yml` reports (backups, host updates) and the deploy's health checks ([cicd](../cicd.md)) | an availability breach: a backup that stopped, a lost volume |
| The host's security stack, operated by the school's DSI (its firewall and endpoint protection) | an intrusion on the shared host - **the DSI sees it first, and the duty to tell us is part of the hosting agreement that is still OPEN** ([dso-dossier](dso-dossier.md)) |
| Container logs and the per-deploy archive ([logging](../infrastructure/logging.md)) | the evidence afterwards |
| A user ("I can see somebody else's ...") | an authorisation defect |

## 3. The clock and who decides

**The 72 hours run from the moment the association is AWARE** - reasonably certain that a security
incident has compromised personal data - not from the moment the incident happened, and not from
the moment the analysis is finished. Art. 33(4) allows notifying in phases: notify within 72 h with
what is known, complete afterwards.

| Step | Who | Deadline |
| --- | --- | --- |
| Contain (revoke a token, take a route down, rotate a credential, isolate the dev estate) | the technical lead on duty | immediately; containment never waits for the decision below |
| Open an entry in the breach register (section 7) with the time of awareness | the technical lead | T0 |
| Inform the bureau (president, or the member delegated for data protection) | the technical lead | T0 + a few hours |
| Inform the DSI when the shared host or the school's network is involved, and the school's DPO | the bureau | T0 + 24 h |
| Assess the risk (section 4) and decide: no notification / CNIL / CNIL + data subjects | **the bureau, as the controller's representative**, after the DPO's opinion when it can be had in time | before T0 + 72 h |
| Notify the CNIL (section 5) | the bureau | **T0 + 72 h at the latest**; a later notification states the reasons for the delay |
| Notify data subjects (section 6) | the bureau | without undue delay once a HIGH risk is established |
| Close the register entry (cause, measures, lessons) and add the story to `CHANGELOG.md` without personal data | the technical lead | when fixed |

For **MiGallery** the same steps apply with **MiTV** (`bureau@mitv.fr`) as the deciding controller;
Rootz, which operates the infrastructure, informs MiTV at T0.

When the incident sits at a **processor** (Google FCM, Apple APNs, Cloudflare, Lydia, KLIPY, Google
Safe Browsing - the list is in [register-of-processing](register-of-processing.md#8-processors-and-recipients)),
the processor must tell us without undue delay (Art. 33(2)); our clock starts when it does.

## 4. Assessing the risk

Score the breach on the CNIL / EDPB method (guidelines 9/2022): nature of the breach, categories
and volume of data, ease of identification, severity of the consequences, special characteristics
of the people (minors: students can be 15-17), number of people.

| Outcome | Action |
| --- | --- |
| Unlikely to result in a risk (e.g. ciphertext only, keys safe, quickly contained) | register entry only, with the reasoning (Art. 33(5)) |
| A risk | CNIL notification |
| A HIGH risk (e.g. the directory with promo and group memberships published, face data of MiGallery, payment rows, a session forgery used) | CNIL notification AND notice to the people concerned, unless Art. 34(3) applies (data unintelligible, risk neutralised, or disproportionate effort - then a public notice in the app instead) |

## 5. Notifying the CNIL

1. Use the CNIL online service for breach notifications (`notifications.cnil.fr`, reached from
   cnil.fr, "Notifier une violation de donnees personnelles"). It allows an initial notification and
   a complementary one.
2. Content required by Art. 33(3): the nature of the breach, the categories and approximate number
   of people and of records, the contact point (`bureau@rootz-emse.fr`, or the school's DPO if the
   school is found to be joint controller - [dso-dossier](dso-dossier.md)), the likely consequences,
   the measures taken or proposed.
3. Keep the CNIL's acknowledgement and the notification number in the register entry.

## 6. Notice to the people concerned (template, French)

Sent by e-mail to the address on the account and shown as an in-app notice; it must be in clear
and plain language (Art. 34(2)).

```text
Objet : Information importante concernant vos données personnelles - [Canari / MiConnect / ...]

Bonjour,

Le [date], nous avons découvert un incident de sécurité concernant [service]. [Décrire en une ou
deux phrases ce qui s'est passé, sans jargon.]

Données concernées : [liste précise - par exemple nom, prénom, promotion, appartenance à des
groupes]. Les contenus de vos messages privés, chiffrés de bout en bout, [n'ont pas / ont] été
concernés.

Conséquences possibles : [par exemple tentatives d'hameçonnage utilisant votre nom].

Ce que nous avons fait : [mesures prises - correction, révocation des sessions, signalement à la
CNIL le [date]].

Ce que nous vous recommandons : [par exemple se méfier des messages demandant vos identifiants ;
se déconnecter puis se reconnecter ; changer le mot de passe de votre compte de l'école si ...].

Pour toute question : bureau@rootz-emse.fr. Vous pouvez aussi contacter la déléguée ou le délégué
à la protection des données de l'école, ou introduire une réclamation auprès de la CNIL
(www.cnil.fr).

L'association Rootz - EMSE
```

## 7. The breach register (Art. 33(5))

**Every breach is recorded, notified or not.** The register is kept OFF the public repository
(it can name affected people and unfixed causes); this is its template. One row per breach:

| Field | Content |
| --- | --- |
| Id | `BR-YYYY-NN` |
| Detected at / aware at | two timestamps, UTC; the 72 h run from the second |
| Service(s) | Canari, MiConnect, MiGallery, Sky, Le Cercle, Portail-etu, a processor |
| Description | what happened, how it was found |
| Data and people | categories, approximate counts, whether minors are included |
| Consequences | likely effects for the people |
| Risk level and reasoning | none / risk / high risk, and why |
| Measures | containment, fix, prevention |
| CNIL notified | no (and why) / yes, date and reference |
| People notified | no (and why: Art. 34(3) ground) / yes, date and channel |
| Closed at | date, and a link to the `CHANGELOG.md` entry |

## 8. What is OPEN

- The hosting agreement with the DSI does not yet say that the DSI informs the association of an
  incident on the shared host, nor how fast ([dso-dossier](dso-dossier.md)).
- The off-repository location of the breach register and of the bureau's role assignment is not
  recorded anywhere yet.
- No breach drill has been run.
