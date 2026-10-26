### Fixed - a waiter on the add lock is told when it is released, and a rebuilding Add renews it

A refused re-plan is re-planned when the holder releases rather than at the lock's TTL; a rebuild renews the lock or ends the Add; one marker per acquisition; an unanswered acquire is never "busy" ([mls-protocol](docs/wiki/protocols/mls-protocol.md#an-invitation-whose-kept-commit-did-not-land-is-re-planned-or-the-member-is-told-2026-10-25)).
