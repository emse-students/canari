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
2. **MET in code (2026-11-17), unrun against the live page**: `login.mjs` ticks the box on the web and in the
   Android Custom Tab (`idpform.mjs`), and `signInThroughSheet` (`phone-ios.mjs`) now knows a `terms` stage -
   a sheet showing a control labelled "J'ai lu les conditions d'utilisation..." is ticked, then "Continuer" is
   tapped, once (pinned by `archive/ios-observables-selftest.mjs`, against a fake device). How WDA types the
   web checkbox is unknown until the page is up: the first run of condition 3 is its proof, and a mismatch
   is a one-line fix to `findTermsBox`.
3. **HALF (2026-11-17): BOUND to ONE provider, the web read PASSED, the two phone readings are owed.** With the
   owner's yes, the held `45-consent.yaml` was applied through the blueprint importer (the flow, prompts,
   policies and stages only) and the harness's `miconnect-canari-local` provider alone now authorizes through
   `miconnect-authorization`; the other eight providers were listed before and after and are unchanged. A web
   sign-in of a test account then showed the terms page, the tick was accepted, the authorization ended on the
   redirect, and a second authorization skipped the page. Owed: the prompt read on the Mi 9T and the iPhone 12
   against the `Canari Local` client, then lift the hold for the eight. **Revert of the binding** (generic): in an
   `ak shell`, set that provider's `authorization_flow` back to `default-provider-authorization-implicit-consent`;
   the saved before-state is in the private operations folder, and the next stable's `apply-blueprints.sh` does
   it by itself (the blueprint still names the implicit flow). The flow and stage objects may stay, inert.

**The lead lifts the hold** once the three hold, and tells the user (decided 2026-10-18).
