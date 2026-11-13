### Added - group calls: one media key per sender (WP-GC1)

A group call exports one key per participant from the conversation's MLS group, and the E2E worker
holds one send key and a receive key per other participant; the 1:1 keys are unchanged, so old and
new clients still call each other ([calls](docs/wiki/frontend/modules/calls.md#one-key-per-sender-wp-gc1-2026-11-13)).
