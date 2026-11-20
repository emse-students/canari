### Fixed - dev's TURN budget meter held a revoked token, so dev calls got STUN only

From 2026-11-19 until the `1.7.1-alpha.7` deploy, the meter on dev used a token that had been rolled without its GitHub secret being updated. A token roll is complete only once the secret carrying it is rewritten and the consumer redeployed ([MIGRATION](infrastructure/MIGRATION.md)).
