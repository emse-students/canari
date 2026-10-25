### Fixed - a CC race forgives the Add narration to the racer that made the Add

The Add narration was forgiven to W1 alone, so a racer other than W1 that Adds read its own Add as dirt, and CC-1's W2 lock loser was not forgiven the block question it asks before the lock refuses it (alpha.4). Forgiveness is now per gesture, and the lock loser is never forgiven a commit line (`raceForgiveness` in `tools/cross-client-harness/ccrows.mjs`).
