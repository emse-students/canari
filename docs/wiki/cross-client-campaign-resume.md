# Resuming the cross-client campaign

The campaign was paused on 2026-08-30 for want of a phone. Between that pause and now, three things
landed on `main` that a run has to account for: the `dev.canari-emse.fr` estate, the CD unification
that deploys it, and the dependency chain that can merge and deploy with nobody at the keyboard.

**This page is the DELTA and the ordered restart, and nothing else.** Where the campaign stands is
the [board](cross-client-testing.md); what each rung is for is the
[campaign page](cross-client-campaign.md); why a result may be believed is
[testing-methodology](testing-methodology.md); how to drive the rig is
[the harness README](../../tools/cross-client-harness/README.md). None of that is restated here.

---

## 1. The one thing that did NOT change, and it is the important one

**The campaign still runs against PRODUCTION.** `dev.canari-emse.fr` exists now, but the rig cannot
be pointed at it: 89 files under `tools/cross-client-harness/` name `canari-emse.fr` as a literal,
with no central constant to change. There is no flag, no env var and no partial support.

So: **a dev estate does not make the campaign safer, and it does not lift the rule that a campaign
run and a push to `main` are mutually exclusive.** Anyone who reads "we have a dev environment now"
and concludes the rig moved will run 40 minutes of checks against production while believing
otherwise, which is the failure this paragraph exists to prevent.

Moving the rig to dev is a real option and it is one change - a host constant threaded through
`chat.mjs`'s `client()` and the handful of direct `goto` calls - but it is NOT done, it would need
every account re-enrolled on dev, and it would answer a different question: dev's data is a copy of
production's, but dev's MLS state, its device rows and its push tokens are not production's. A rung
that measures a POPULATION would still have to run on production.

---

## 2. What changed, and what each change does to a run

| Change | Effect on a run |
|---|---|
| A push to `main` now deploys **dev first, then production** | The mutual-exclusion rule is unchanged, but the window is LONGER: one push occupies the pipeline for both estates. |
| A failed dev deploy **blocks** the production deploy | `main` can be ahead of what production is serving. **Read the build from `/api/version`, never from `git log`** - a verdict stamped with a commit production never received is a verdict about nothing. |
| `Dependabot auto-merge` sweeps **hourly** and after every CD run, and dispatches `cd.yml` itself | **This is the new hazard.** Production can be redeployed mid-run by a merge nobody performed. See section 3. |
| The weekly dev refresh, Mondays 04:00 UTC | Stops and restarts DEV's containers only. It touches nothing production serves, so it can never void a row - named here so nobody blames it for one. |
| Push credentials are now permitted on dev | Irrelevant to the campaign today. It matters only once a dev-built mobile app exists, which is phase 2. |
| `vars.DEV_ENVIRONMENT_ENABLED` | While it is absent or not `true`, every dev job skips and CD behaves exactly as it did during the campaign's last runs. |

---

## 3. Before a run: stop the pipeline from moving under it

The dependency sweep is the one thing that can redeploy production while a run is in flight, and
unlike a human push it will not wait. Two commands, and they are reversible:

```bash
gh workflow disable "Dependabot auto-merge"   # before the session
gh workflow enable  "Dependabot auto-merge"   # after it
```

Disabling it is not a statement that the sweep is wrong - it is the same rule that already forbids a
manual push during a run, applied to the merges that push on their own. **Re-enable it in the same
session**, because a sweep that stays off is a repository that stops taking its own updates, which is
exactly what the dependency chain was built to end.

If it was left on and a run looks wrong, `gh run list --workflow=cd.yml` settles it: a CD run whose
timestamps overlap the run is a voided measurement, not a defect.

---

## 4. The restart sequence

Everything below is in order, and nothing else goes first.

1. **`git fetch`, then PUSH whatever is local.** A push redeploys production, so it cannot happen
   during a run. Background it, redirect rather than pipe, read `PUSH_EXIT`, and `rm -rf apps/*/dist`
   first.
2. **`gh run list`** - CD green **and quiet** before any row. "Quiet" now means dev's three jobs too:
   with the switch off they show as skipped, which is the expected shape and not a failure.
3. **Prove production actually answers**, because a green deploy proves containers started:
   `curl -s https://canari-emse.fr/api/version`. The `version` it returns is the build every verdict
   from this session will be stamped with.
4. **`node state.mjs`** - the clients, what they are logged into, and what they are running.
5. **`node rows.mjs`** - the board against the ledger. It has caught the board wrong three times.
   Run it before believing any cell, including the three the board itself marks as NOT settled
   (DEL-10, COMM-8, COMM-23).
6. **Reload W1 and W2 onto the current bundle.** A client left open across a deploy runs yesterday's
   code and every line it logs will be read as though it did not.
7. **If the phone is in play**: the from-zero sequence is scripted end to end in
   [the harness README](../../tools/cross-client-harness/README.md#operating-it). A deploy cannot
   reach an APK - a row whose question is not skew needs the APK rebuilt and installed first.
8. **Re-measure the device cap around the run.** It is re-measured, never quoted.

---

## 5. What the pause did not change about a verdict

- **The logs are read on every pass, the reconciliations especially** (user, 2026-08-28). A heal that
  works is not a heal that was observed; reading them has since found one P1 no row asks about and
  turned one `FAIL` into another.
- **Expected noise is dispositioned per row** with `ignoringExpectedLog`, never with a wider
  classifier.
- **No HEAL-REVOKE verdict about a clean device may be taken on a build older than 0.14.12.**
- Losing a `chrome-w1` / `chrome-w2` profile costs a re-enrolment and SETUP-4's 2FA, the one step no
  tool here answers.

---

## 6. What is still blocked, and what is not

**Blocked on hardware** - the whole list, each row with what would arm it, is
[the verification table at the top of backlog](backlog.md#owed-a-verification-and-nothing-else).
A precondition is not ambient: the quick-reply window must be ARMED, and an unarmed run proves
nothing at all.

**Takeable with no device**, and worth doing while waiting:

- the four population rows written into rung 12 MULTI (7-10), which need only `W1 W2`
- the second iPhone that acquires no push token and reports nothing, diagnosable with no phone
- the P1 livelock of 2026-09-01 (a device asking for a Welcome every 60 s for 20 hours while the
  member answering `[KICK]`s it back to `pending`), which is a server-side question

---

## See also

- [cross-client-testing](cross-client-testing.md) - the board: every check, its verdict, its build
- [cross-client-campaign](cross-client-campaign.md) - the ladder, the scope, the preflight
- [testing-methodology](testing-methodology.md) - why a result may be believed
- [dev-environment](infrastructure/dev-environment.md) - the estate the rig does NOT yet use
- [cicd](cicd.md) - the sweep, the ceiling, and what dispatches a deploy
