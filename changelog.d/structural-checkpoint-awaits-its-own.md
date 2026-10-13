### Fixed - a join is declared durable only once a checkpoint holding it is written

A flush made while a checkpoint ran was handed that checkpoint, which had exported before the change, so `externalJoin` could be acknowledged before its join reached disk. A failed checkpoint now leaves the state dirty ([mls-desync-prevention](docs/wiki/protocols/mls-desync-prevention.md#the-checkpoint-a-caller-awaits-is-the-one-that-exported-after-its-change-2026-10-14)).
