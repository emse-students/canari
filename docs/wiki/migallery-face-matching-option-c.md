# MiGallery face matching - option C (stored embeddings, no clustering)

**Status: DECIDED by the owner on 2026-10-25, nothing built on a host.** Lot A1 is the first code
(a draft pull request in the MiGallery repository). This page is the design, the lots and the
measurements behind them; the legal side is [dpia-migallery-faces](compliance/dpia-migallery-faces.md)
and stays OPEN until the school's DPO answers ([dso-dossier](compliance/dso-dossier.md)).

**No photo, face, embedding, name or id was kept by any measurement here.** Only counts and
aggregates, taken read-only on 2026-10-24. Every figure below is a measurement unless it says
"derived" or "NOT MEASURED".

## 1. What is decided

| Question | Decision |
| --- | --- |
| Model | **buffalo_l, kept.** Its 512-d embeddings already exist for every stored face, so no re-embedding of the archive and no model change. Each stored vector carries a model tag. |
| Store | A durable store of one **float16 512-d** embedding per detected face (about 1 KB each), encrypted at rest, loaded into memory by the matcher. **No clustering**: nothing groups faces into persons any more. |
| Reference per member | **3-5 references** (selfie and photos), stored encrypted, never returned by any route. |
| Match rule | **Minimum cosine distance** to the member's references. |
| Thresholds | **<= 0.5 auto-accept** (the conservative band, today's Immich value). **0.5 to ~0.62 = "suggested", needs the member's confirmation.** Above 0.62 no match. |
| Ambiguity | A face whose runner-up member is within a margin of the best is never auto-accepted. |
| Seeding | From the vectors Immich already holds: no recomputation. |

**The price, stated plainly.** Option C is a standing store of biometric templates of people who
never asked, non-members included: exactly what the DPIA names as its main risk (R1). It was chosen
over a match-only design (option A, hours of compute per enrolment batch) for latency and cost. It is
a legal decision for the DPO, not a compute one, and nothing here may reach production before that
answer. Withdrawal must therefore delete a member's references and matches synchronously and
completely, and the store must be erasable as a whole.

## 2. Measurements (2026-10-24)

Host class: 4 cores, about 7.6 GiB, no usable GPU; the ML container is capped at 2 CPUs and 2 GiB.
Archive: 172,312 photos, 157,736 with at least one face (91 %), 600,082 face rows, 512-d vectors,
3.5 GB on disk in the current database. 469 members, 313 linked to a person. Faces of linked persons:
108,865 (18.1 %); faces of everyone else: about 491k (81.9 %).

**Cost of one image through the ML service** (200 random previews of about 2160 px, 3.9 faces per
image, 2 CPUs):

| Mode | p50 s | p95 s | mean s | throughput per s |
| --- | --- | --- | --- | --- |
| detect + embed | 0.355 | 1.072 | 0.468 | 2.14 |
| detect only | 0.155 | 0.165 | 0.157 | 6.34 |

Detection is a constant ~0.155 s (fixed 640x640 letterbox); embedding is ~0.080 s per face. The
service cannot embed a supplied box (recognition needs the detector's five landmarks), so a store of
boxes alone is not cheaper. 4 CPUs give only 1.6-1.8x.

**Store size and match cost** (random unit vectors, 512-d, 600,000, 2 CPUs):

| Format | Memory | Match 1 ref | Match 10 refs | Match 300 refs |
| --- | --- | --- | --- | --- |
| float32 | 1,229 MB | 0.17 s | 0.60 s | 1.39 s |
| float16 (decoded per chunk) | 614 MB | 1.21 s | 1.50 s | 2.20 s |
| int8 (decoded per chunk) | 307 MB | 0.50 s | 0.93 s | 1.70 s |

Encryption adds 28 bytes per vector (+17 MB). **An enrolment is about 1-2 s end to end** (selfie
0.4 s + match 0.2-1.4 s); loading the store into memory (decrypt about 1.2 GB) was NOT MEASURED, a
few seconds expected.

**Seeding.** Reading the existing vector column: 10k rows 0.60 s, 50k rows 1.31 s, so 600k rows is
about 16-36 s of database time. TRAP: ordering the export by id sorted the whole table (77 s for 10k
rows); export in physical order. Parsing the text form into float16 on the client was NOT MEASURED.

**Steady state.** September peak about 417 new assets a day (3.3 min of 2-CPU time), year average
without the August re-import about 133 a day (1.0 min), October about 48 a day (22 s).

**Model comparison and accuracy** (30 linked persons x 20 images = 547 previews, 675 positive faces,
1,865 faces of other persons as negatives; cosine distance; 5 reference faces, minimum distance;
averaged over 5 draws):

| Model | Detects of positives / negatives | Threshold at 1e-3 false-match, recall | at 1e-4 | Recall / false-match at 0.5 |
| --- | --- | --- | --- | --- |
| buffalo_l | 100 % / 100 % | 0.720, 99.9 % | 0.617, 97.6 % | 84.0 % / 2.7e-6 |
| buffalo_m | 92 % / 78 % | 0.720, 99.8 % | 0.621, 98.2 % | 86.5 % / 1.3e-5 |
| buffalo_s | 83 % / 62 % | 0.705, 98.4 % | 0.649, 95.2 % | 73.0 % / 0 |
| antelopev2 | 100 % / 100 % | 0.690, 99.7 % | 0.578, 96.6 % | 89.0 % / 3.7e-5 |

Per-image cost (mean, 2 CPUs): buffalo_l 0.81 s, buffalo_m 0.68, buffalo_s 0.16, antelopev2 1.31. All
four are 512-d. The 0.62 threshold is the buffalo_l figure at about 1e-4 false match per pair.

**Why these figures are optimistic.** Ground truth is Immich's own buffalo_l clusters formed at
0.5, so negatives are by construction not within 0.5 of members and positives are chained clusters.
The 1e-4 thresholds rest on 5-8 impostor pairs per draw. Across 600k stored faces even 1e-4 per pair
is about 60 candidate false matches per enrolled person, so **the ambiguity rule and the human
confirm for the 0.5-0.62 band are not optional.** A false match shows a stranger's photo.

**NOT MEASURED:** independent ground truth; the false-match rate at the scale of 600k; a selfie of a
different age or light than the archive; float16 and int8 quantisation effect on recall; recognition
without re-detection; the effect of any ambiguity margin; videos.

## 3. The lots, adapted to option C

The first study was written for a match-only design. The lots below replace its table: the store,
the seed and the confirm band are new; the backfill scheduler is gone (the store makes a pass
unnecessary).

| Lot | Content |
| --- | --- |
| **A1** | Schema and protection: tables for encrypted references (3-5 per member) and the embedding store, the float16 codec, AES-256-GCM sealing with a key from an environment secret, `secure_delete`, the thresholds as named constants, the distance function. Synthetic vectors only. No route, no ML call. |
| A2 | ML client (`/predict`, exactly one face of score >= 0.7 for a selfie), the matcher: min-distance, the three bands, the ambiguity rule. |
| A3 | Ingestion: new assets are detected and embedded once and appended to the store, durable per-asset state, retries, an hourly report that names the cause of a backlog. |
| A4 | The match engine: on enrolment and on new embeddings, match against the store and persist matches (asset, box, distance, band); confirm and reject state for the suggested band. |
| A5 | Enrolment and withdrawal: selfie embedded in memory and never stored, consent row reused, withdrawal deletes references, matches and crops in one transaction. |
| A6 | Read side: "Mes photos" and the people views read matches; the suggested band is a confirmation screen; the proxy refuses every person and face call. |
| A7 | Seed from the existing vectors (physical order, no recomputation) and migrate the existing links: matches and references per member, calibration, parity. |
| A8 | Cutover: stop the old recognition and clustering, delete the old clusters, verify, record the date backups still hold the old data. A host operation: it needs the school IT department's written agreement first. |
| A9 | Tests, wiki, `/cgu`, DPIA and register rows updated to a stored-template design. |

**What A2 needs from A1:** the codec, the sealing helpers, the distance function and the constants
exactly as A1 exports them, plus the model tag column to refuse a vector of another model.

## 4. Open and owed

- The DPO's answer on a standing store of third parties' templates (DPIA R1) precedes A8, and any
  production use of A7.
- Re-check the 0.62 threshold on independent ground truth before the suggested band ships (A6).
- Measure the memory load of the store and the float16 recall effect before A2 fixes its format.
