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

## 1. The rig targets PRODUCTION today - but that is now a ONE-LINE choice, not a property

**As it stands, a run goes against production, and the mutual-exclusion rule holds: a campaign run
and a push to `main` are mutually exclusive.** `SITE` in the machine-local `names.mjs` says
`https://canari-emse.fr`, so anything launched right now types into production.

**What this page used to say here was wrong, and the correction matters more than the error.** It
read: "89 files name `canari-emse.fr` as a literal, with no central constant to change", and
concluded that a dev estate cannot make a run safer. The count was right and the conclusion was not.
Measured 2026-09-02:

| | count | what it means |
|---|---|---|
| `https://canari-emse.fr` navigation literals | **0** | every navigation goes through `SITE` |
| bare `'canari-emse.fr'` occurrences | 120 | they are CDP **tab matchers**, matched by SUBSTRING |
| anchored comparisons (`startsWith`, `===`, `^`) | **0** | nothing requires the host to BE production |

`dev.canari-emse.fr` contains `canari-emse.fr`, so every one of those 120 matchers still matches a
dev tab. **Pointing the campaign at dev is changing `SITE`** - one line, outside the repository - not
89 files. A count of occurrences is not a measurement of coupling, and this page asserted the second
from the first.

**It is still NOT done, and the reasons to think before doing it are unchanged.** Dev's data is a
copy of production's, but dev's MLS state, its device rows and its push tokens are NOT: the copy
truncates `push_token` and the MLS trees are whatever dev's own clients built. So a rung that
measures a POPULATION - the four rows written into rung 12 MULTI - still has to run on production,
and a `PASS` taken on dev answers "does the mechanism work", never "is production's estate sound".
What dev WOULD buy is real: a destructive row (HEAL, DEL, the revoke ladder) stops being able to
damage anything a member depends on, and the mutual-exclusion rule relaxes to "not while a DEV
deploy is in flight".

**And if it is pointed at dev, one thing has to move with it.** `dev-refresh.yml` re-copies
production into dev on Mondays at 04:00 UTC and on demand - which would wipe a campaign's fixtures
mid-run. On dev it needs the same treatment section 3 gives the dependency sweep:
`gh workflow disable dev-refresh.yml` before the session, `enable` after it. **By FILENAME, not by
name**: the workflow is called `Refresh dev.canari-emse.fr from production`, and an earlier draft of
this page told the operator to disable `"Refresh dev data"`, which matches nothing and fails - an
operator instruction that cannot be pasted is not an instruction.

---

## 2. What changed, and what each change does to a run

| Change | Effect on a run |
|---|---|
| A push to `main` now deploys **dev first, then production** | The mutual-exclusion rule is unchanged, but the window is LONGER: one push occupies the pipeline for both estates. |
| A failed dev deploy **blocks** the production deploy | `main` can be ahead of what production is serving, so **`git log` never says what production is running**. `/api/version` gives `version` and `minClientVersion`, which is what a verdict may cite - but NOT the commit: production renders no `build` by decision (a non-null `build` means you are talking to DEV). To learn which commit production actually received, read the `prod-deployed` tag or the last green `Deploy to Production Server`, never the local branch. |
| `Dependabot auto-merge` sweeps **hourly** and after every CD run, and dispatches `cd.yml` itself | **This is the new hazard.** Production can be redeployed mid-run by a merge nobody performed. See section 3. |
| The weekly dev refresh, Mondays 04:00 UTC | Stops and restarts DEV's containers only. It touches nothing production serves, so it can never void a row - named here so nobody blames it for one. |
| Push credentials are now permitted on dev | Irrelevant to the campaign today. It matters only once a dev-built mobile app exists, which is phase 2. |
| `vars.DEV_ENVIRONMENT_ENABLED` is **`true`** since 2026-09-02 | The dev jobs no longer skip, so **a broken dev estate holds production's deploys**. That is by design and it cuts both ways during a campaign: it makes an accidental production deploy LESS likely, and it means `main` can sit ahead of what production serves for a long time. The escape is `gh variable set DEV_ENVIRONMENT_ENABLED --body false`. |
| `cd.yml` now declares `concurrency: cd-deploy` with `cancel-in-progress: false` | Deploys queue instead of racing. Before 2026-09-02 three ran at once against the same checkout. A queued deploy still deploys - serialising is not the same as stopping, so section 3 is unchanged. |

---

## 2b. THE CAMPAIGN NO LONGER USES REAL ACCOUNTS (2026-09-02)

Decided by the user - *"au lieu de prendre les utilisateurs habituels, tu vas creer des utilisateurs
de test sur MiConnect/Authentik et les utiliser, on va arreter d'utiliser les vrais comptes"*. Two
ordinary Authentik users now exist on `miconnect`:

| key in `test-accounts.json` | username | display name (`names.mjs`) | devices |
|---|---|---|---|
| `owner` | `canari-test-alpha` | `Canari Test Alpha` | W1, W3, A1 |
| `peer` | `canari-test-beta` | `Canari Test Beta` | W2 |

**They sign in through the SERVICE-ACCOUNT link that production's login page already had** - the
small "Connexion externe (service-account)" text button under the main OIDC button. It is
`PASSWORD_LOGIN_FLOW_SLUG = 'password-login'` in `frontend/src/lib/stores/auth.ts`, which sends the
browser to `/if/flow/password-login/?next=<authorize>`. That flow is identification + password +
login and **carries no `AuthenticatorValidateStage`**, so:

- **There is no 2FA in the campaign any more.** The EMSE 2FA was never Authentik's - the
  `miconnect-auth` flow has `user_fields: []`, `password_stage: None` and `cas-emse` as its only
  source, so the main button federates to the school and the school asks. The service-account flow
  does not go there at all.
- **SETUP-4 is retired as written**, and losing a `chrome-w1` / `chrome-w2` profile stops being
  expensive: a re-login is a username and a password, not an enrolment somebody has to sit through.
  It still costs a DEVICE (a fresh profile is a new MLS identity), which is a different price.
- Nothing was changed in Authentik's flows, and **production's main login page is untouched**. Two
  users were created; that is the whole change on the identity provider.

**What the test accounts do NOT have is the campaign's fixtures.** They own nothing: no DM, no
`Campagne de test` community, no group under test, no enrolled devices. Everything the board's rows
navigate to has to be built once, by the test accounts themselves, and none of it needs a privilege:
`POST channels/workspaces` is guarded by `NginxAuthGuard` alone, so an ordinary member creates the
venue. In order: log both in through the service-account link, set each PIN from
`test-accounts.json`, let W1 open a DM to `Canari Test Beta`, create the `Campagne de test`
community with a `general` channel, then the group the DEL and HEAL rungs use.

**The old file is beside the new one.** `test-accounts.json.bak-real-accounts-2026-09-02` and
`names.mjs.bak-real-accounts-2026-09-02` hold the two real accounts, so a row that must be re-run
against the previously measured state is still possible - deliberately, because a verdict taken on
the real accounts cannot be reproduced by the test ones.

---

## 2c. Bringing the rig up on ANOTHER machine

Everything machine-local lives in ONE directory beside the repository, `canari-harness/`, and that
split is structural rather than a policy: a credential outside the work tree cannot be committed to
a public repo at all. Moving to a new PC is moving that directory.

| What | Why it cannot simply be recreated |
|---|---|
| `test-accounts.json` | the only copy of the two passwords and PINs - they exist nowhere else, by design |
| `names.mjs` | the display names, `SITE`, the CDP ports, `ACCOUNT_OF`, `VENUE` |
| `chrome-w1/`, `chrome-w2/`, `chrome-w3/` | **THESE ARE THE DEVICES.** The profile holds the session, the MLS identity (`mls_device_id_<userId>`, the IndexedDB state) and the enrolment. A fresh profile is a NEW device, which changes what a row measures |
| `results.ndjson` | the verdict ledger `rows.mjs` checks the board against |
| `apk/`, `a1-baseline/` | the debug APK under test and the phone's baseline |

Then, inside the repo, `tools/cross-client-harness/names.mjs` must be the **two-line pointer**, not a
copy of the values - the shape is spelt out in `names.example.mjs`. Nothing else in the repo needs to
know the split exists: `STATE_DIR` has exactly three consumers.

Also needed on the machine: node, `adb` on `PATH` for the A1 rows, and a Chrome the profiles were
written by. **Verify before trusting anything**: `node -e "import('./names.mjs').then(n=>console.log(n.SITE, n.OWNER_NAME))"` from
`tools/cross-client-harness/`, then `node rows.mjs`, which fails loudly if the ledger and the board
disagree.

**If the profiles are NOT copied** - a clean machine, or a decision to start fresh - then every
device is new, and that is now cheap: the service-account login needs no 2FA. What it is not is
free, because a new device has no history, so every HEAL row's precondition has to be rebuilt and
any row whose verdict depends on an existing device must be re-run rather than trusted.

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
2. **`gh run list`** - CD green **and quiet** before any row. "Quiet" now means dev's three jobs
   too, and since 2026-09-02 they RUN rather than skip: a dev job in flight means a production
   deploy is queued behind it, so the pipeline is not quiet yet.
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
9. **On the FIRST session after 2026-09-02, the accounts are new** (section 2b). `node state.mjs`
   will report W1 and W2 signed in as the OLD accounts, or signed out, depending on what the
   profiles were left holding - that is expected, not a fault. Sign both in through the
   **service-account** link, set each PIN from `test-accounts.json`, and rebuild the fixtures the
   board's rows navigate to. **A row run before the fixtures exist opens nothing and then reports on
   whatever conversation happened to be on screen**, which is the failure `names.mjs` exists to
   prevent and the reason this step is numbered rather than assumed.

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
