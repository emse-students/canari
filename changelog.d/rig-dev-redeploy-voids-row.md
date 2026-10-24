### Fixed - a row the dev estate was redeployed under is VACUOUS, not failing

On dev the rig voids a row whose window saw dev's build change, a pre-release run (read by tag), a dev container restart or a seed reset, and a dev window it could not read is VACUOUS rather than PASS; the local estate keeps its restart check ([harness README](tools/cross-client-harness/README.md#the-files)).
