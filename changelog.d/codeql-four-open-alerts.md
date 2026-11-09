### Fixed - four open CodeQL alerts closed

A null check ordered after the `typeof` that hid it (both copies of the answer text), a test import ahead of its first use, a handler called with an argument it never reads; no behaviour change ([cicd](docs/wiki/cicd.md)).
