### Fixed - a SETTLE subject that never lists is judged FAIL by the roster, not thrown on by the invariant

Eight SETTLE rows on 1.4.1-alpha.3 recorded ERROR or INVALID because the invariant threw opening a conversation the subject never listed; the subject now leaves the invariant's members, and the admission gate's not-drained decision line reads NOTABLE ([cross-client-testing](docs/wiki/cross-client-testing.md)).
