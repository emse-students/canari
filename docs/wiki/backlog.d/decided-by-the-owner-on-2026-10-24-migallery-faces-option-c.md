## Decided by the owner on 2026-10-24 - MiGallery faces: option C

The DPIA's measure 1 ([dpia-migallery-faces](../compliance/dpia-migallery-faces.md#6-open-measures)) is
**option C**: a per-photo store of face embeddings, **no clustering and no persons**; a member's
photographs are found by matching their own reference at search time. The embeddings are kept as long
as the photograph exists and are **excluded from backups**; they live in MiGallery's OWN encrypted
store, not in Immich, and recognition runs in MiGallery's worker through a pinned machine-learning
image. **The owner takes responsibility for the Art. 9 question** (non-members' embeddings are still
computed). **No work package is written before the model comparison.** The DPO is still asked
([dso-dossier](../compliance/dso-dossier.md#q3---validez-vous-laipd-de-migallery-)).

**Written in MiGallery and not yet deployed (2026-10-31, lots A1-A9; the seed and the A8 cutover
not yet run)**, with three
changes decided since: matches are stored, the model is Immich's own service over a dedicated
internal network, and buffalo_l was kept after the comparison. The owner went ahead before the DPO's
answer. The DPIA and register row G3 carry the facts, every changed assessment marked to be
re-assessed by the owner; the mechanism is [MiGallery face-matching-option-c](https://github.com/emse-students/MiGallery/blob/main/docs/wiki/face-matching-option-c.md).
