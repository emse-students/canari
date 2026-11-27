### Added - the admission card read on a built state (ADM-11, ADM-12)

The card for a person with no leaf whose seat is not an invitation-link ask was never reached through the product's own revoke path; the rig now builds that state (`archive/admitcard.mjs`) and read it on dev: the card shows, Refuser removes the seat and the person's external commit is then refused, Accepter brings them back ([admission fix-forward](docs/wiki/protocols/admission-fix-forward.md#slice-2s-reading-on-a-built-state-2026-11-26)).
