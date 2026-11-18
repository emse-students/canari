## P1 - The MiConnect terms stage reaches production with the next STABLE: three things come first (2026-10-16)

target: 1.7.1

_2026-11-18, sitting [S8](../device-verification.md#the-phone-readings-of-2026-11-18-s8-170-alpha12-the-miconnect-terms-prompt-not-taken): **the two phone readings were NOT TAKEN, and the entry moves to `1.7.1`; the hold stays.** The `1.7.0` stable's `apply-blueprints.sh apply` (09:08 UTC) reset `miconnect-canari-local` to the implicit-consent flow, as this entry said it would, so no provider authorizes through `miconnect-authorization` any more and there is no terms page to read; binding a provider again is an identity-provider write the sitting did not hold. **A second obstacle, found on the way, decides the next attempt:** the phones' pre-release builds authorize through `Canari Dev`, never `Canari Local` (the development environment's client id, read in dev's bundle), so an in-app sign-in on dev never reaches the provider that was bound. The prompt "read on the phone against `Canari Local`" can only be a phone BROWSER opened on that provider's authorize URL, ending on a redirect and not in the app. To read it **in the app, signed in**, the provider bound for the reading must be `miconnect-canari-dev` (an identity-provider write, owner's yes, reset by the next stable's apply like the last one), or the phone must run a local-estate build. The flow, prompt, policy and stage objects stay on the identity provider, inert. No product defect was found._


_2026-11-18, sitting [S7](../device-verification.md#the-web-and-phone-readings-of-2026-11-18-s7-170-alpha12-the-last-sitting-before-the-stable): **read on the stable's day, and it does NOT block cutting the `1.7.0` stable.** The hold is lifted by the lead with the stable once the two phone prompts are read against the `Canari Local` client; if they are not, the hold simply stays (the eight providers keep the implicit consent flow, as in production today) and the entry moves to the next stable._

_2026-11-17, scope cut: KEPT in `1.7.0` - only the two bench phone readings are left before the hold is lifted ([decisions](owner-decisions-of-2026-11-17.md))._

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
3. **HALF (2026-11-17): the web read PASSED; the binding ENDED with the `1.7.0` stable (2026-11-18), and the two phone readings are owed** (see the S8 line above for the provider they need). With the
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
