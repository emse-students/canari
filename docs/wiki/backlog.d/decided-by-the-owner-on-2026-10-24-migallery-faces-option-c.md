## Decided by the owner on 2026-10-24 - MiGallery faces: option C

The DPIA's measure 1 ([dpia-migallery-faces](../compliance/dpia-migallery-faces.md#6-open-measures)) is
**option C**: a per-photo store of face embeddings, **no clustering and no persons**; a member's
photographs are found by matching their own reference at search time. The embeddings are kept as long
as the photograph exists and are **excluded from backups**; they live in MiGallery's OWN encrypted
store, not in Immich, and recognition runs in MiGallery's worker through a pinned machine-learning
image. **The owner takes responsibility for the Art. 9 question** (non-members' embeddings are still
computed). **No work package is written before the model comparison.** The DPO is still asked
([dso-dossier](../compliance/dso-dossier.md#q3---validez-vous-laipd-de-migallery-)).
