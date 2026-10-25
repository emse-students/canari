### Fixed - NET-3 opens its captive portal only once the commit is held, so the commit is what meets it

The portal had answered the Add's own pre-checks first, so no commit was ever made. Now the commit is held, then the portal opens and answers the held commit with its page. `fault.mjs` gains a rule-level `when` gate and `answerHeld` ([cross-client-testing](docs/wiki/cross-client-testing.md)).
