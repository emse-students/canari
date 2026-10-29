### Added - the server derives a new cotisation tier's key from its label

`deriveVariantKey` on a membership product makes social-service build the tier key from the label, unique among the association's tiers, and `cotisation-options` says so with `tierKeyFromLabel`; an explicit key is still honoured for older clients ([cotisations](docs/wiki/cotisations.md#a-new-tiers-key-is-derived-from-its-label-server-2026-10-26)).
