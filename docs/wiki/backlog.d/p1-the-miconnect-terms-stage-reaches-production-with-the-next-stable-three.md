## P1 - The MiConnect terms stage reaches production with the next STABLE: three things come first (2026-10-16)

target: 1.7.0

**Re-read 2026-11-11: still HELD, and nothing moved since 2026-10-18.** `45-consent.yaml` still waits
in `infrastructure/authentik/blueprints/held/` (`held-blueprints.test.sh`, `test-blueprints.sh`), so
the 8 providers keep `default-provider-authorization-implicit-consent`. Lifting it is a `git revert`
of the hold's commit, which also restores `changelog.d/miconnect-terms-of-use.md`. The mechanism, the
rollback and the fail-open property are in
[authentik](../infrastructure/authentik.md#the-terms-of-use-are-a-stage-of-the-authorization-flow-2026-10-16).

The three conditions, in order:
1. **MET** (2026-10-18): `/legal/miconnect` answers 200 on dev.
2. **HALF**: `login.mjs` ticks the box on the web and in the Android Custom Tab (`idpform.mjs`,
   pinned by `archive/idpform-selftest.mjs`, never run against the live page). The iOS sheet path
   (`signInThroughSheet`, `phone-ios.mjs`) still knows only the system consent alert, not the terms
   page. Owed: teach it the page, or set the iPhone account's `cgu_version` (a read-modify-write of
   the whole attributes bag).
3. **NOT MET**: the prompt read on the Mi 9T and the iPhone. One MiConnect serves dev and production,
   so bind `miconnect-authorization` to ONE provider first (the harness's `Canari Local`), read it on
   both phones, then lift the hold for the eight.

**The lead lifts the hold** once the three hold, and tells the user (decided 2026-10-18).
