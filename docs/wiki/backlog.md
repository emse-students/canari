# Backlog

**The entries live in [`backlog.d/`](backlog.d/README.md), one file each, and each names the version
it is planned for** (`target: 1.7.0`, owner, 2026-11-13). **The order is [plan](plan.md)**, generated (`bun tools/backlog-plan/plan.mjs`)
from those lines in every checkout and never committed ([why](cicd.md#the-plan-page-is-generated-where-it-is-read-2026-11-21)). This page holds the rules every entry follows and, below, the one list of what only
the USER can do. Since 2026-11-13 it carries no entry: the 150 entries and the 137 verification rows
it held moved to `backlog.d/`, each with its target ([roadmap log](roadmap.md#log-of-replannings-and-milestones)).

**Everything is SCHEDULED** - the user's decision of 2026-08-18: nothing is parked, and since
2026-11-13 every entry names a real version (no `later`): an entry nobody will do is deleted with its
evidence, not parked. An entry blocked upstream, on hardware the bench does not hold, on credentials
somebody else owes or on an owner decision says which; it keeps its version and is replanned when
that version ships without it.

Severity uses the repo scale: **P1** security, or a user-facing path that is broken - **P2**
correctness, nothing at risk - **P3** hygiene. An item with no severity is a QUESTION or a chantier,
and its first task is to answer the question rather than to write code.

Each entry states what is known, so that picking it up does not start with a rediscovery. **Delete an
entry outright when it ships** - the rule goes to [durable-rules](durable-rules.md), the story to
`changelog.d/`, the mechanism to the wiki page that entry points at; closed as moot, the evidence goes
in the closing commit or its changelog fragment. An entry describing its own fix is an entry nobody
trusts to be current.

**A FIXED THING OWED ONLY ITS MEASUREMENT IS A READING**: its title opens `Reading owed - `, it says
what is built and the reading that closes it, and it targets the EARLIEST version, where
[plan](plan.md#readings-owed) lists every reading as one checklist (owner, 2026-11-13: *"au plus tot,
marre de trainer ca"*). Where an entry keeps an open half, the shipped half is a pointer, never a
retelling.

**READINGS MUST BE AT 0 BEFORE A STABLE ONLY** (owner, 2026-11-15). A pre-release may ship so that the readings that need its code can be read on it; the stable waits for 0.

**NO ENTRY IS WRITTEN HERE.** A heading added to this page is refused by
`.github/scripts/tests/backlog-fragments.test.mjs`; `backlog-plan.test.mjs` refuses a fragment with no
target or an unknown one, and a `plan.md` that is committed.

---

## Owed to the USER - decisions, rotations and one-off clicks

**This section holds NO substance.** Every line points at the entry that carries it, and exists only
so that "what is waiting on me" is one list rather than a sweep of the file (user, 2026-09-02:
*"Fais moi une liste des choses qu'il me reste a faire"*). Delete a line when its target entry ships
or its click is made. A line here is a thing NO agent can do - a decision, a credential somebody
else holds, a console owned by the user, or hardware that does not exist.

| What | Kind | Where the substance is |
| --- | --- | --- |
| **open dev's calls once after the deploy that carries migration 014** (B12): `/admin/platform`, `Audio et video` - the migration lands `off` on an existing database. (The TURN meter's four secrets EXIST since 2026-10-21, Account Analytics read only.) | 1 click | [calls](frontend/modules/calls.md#the-servers-kill-switch-and-the-metered-turn-budget-b12-b7-2026-10-21) |
| **reread the terms' lives paragraph and the privacy text (written 2026-10-29, draft pull request, the points to decide on [live-production](frontend/modules/live-production.md#5-the-privacy-policy-and-the-terms---written-2026-10-29-owed-the-owners-reread)), and write the filtering statement for the store review** | 1 reread, 1 statement | [live-production](frontend/modules/live-production.md#2-the-gates-each-with-its-evidence) (G10, G11) |
| **send the DPO dossier to the school's DPO** and bring back the answers to its three questions (the school's role, the hosting agreement with the DSI, the MiGallery DPIA); MiTV keeps the proof of each member's face-recognition consent | 1 e-mail, 1 conversation | [the GDPR entry](backlog.d/p2-gdpr-compliance-the-open-items-of-the-register-2026-10-16.md), [dso-dossier](compliance/dso-dossier.md) |
| **close what Stripe left outside the code, and the two Lydia papers**: delete Stripe's webhook endpoint, then close the account once no refund can be asked (the GitHub secrets are already gone, 2026-11-19); sign the Lydia partnership contract; bring the proof that the payer e-mail is not kept | 2 clicks, 2 documents | [backlog.d](backlog.d/owed-to-the-user-after-the-stripe-removal.md) |
| **Lydia's three still-open Livrable A answers** - the KYC document list (channel confirmed: email, not yet arrived), the minimum payable amount, and rate limits/webhook-sandbox testing | blocked upstream | [WP-LYDIA-1](frontend/modules/payments.md) |
| **the dev mobile half: a dev keystore and where it is backed up, and a second package id so a pre-release installs beside the production app** (push is NOT in it: dev sends push since 2026-10-21, measured 2026-11-14). A pre-release store build points at dev and replaces production's app on a device, with production's FCM sender app | 1 console visit, 1 decision | [the second package id](backlog.d/p3-a-second-package-id-so-a-pre-release-can-be-measured-against-production.md) |
| **the spaces release order (WP6b), three gestures in THIS order**: (1) go for the WP3 profile backfill on production once 6a/6d's release ran migration 071 (`backfill-canari-profiles.sh apply`); (2) set every association's real reach and the BDEs at `/admin/spaces` - the seed gave all of them (ICM, saint-etienne) only; (3) only then cut the release carrying 6b. Out of order, ISMIN/Gardanne/FSSS/Autre readers see no existing association post, and anyone not backfilled loses the feed | 1 go, 1 grid, 1 release | [profiles-and-access](profiles-and-access.md), "WP6b as built" |
| **turn off JavaScript detections on the `canari-emse.fr` zone** (Security > Bots): its injected inline script is refused by the page policy on every dev document, one console error per load; production is not behind Cloudflare. Done when a dev document's console holds no CSP refusal, and the rig's `DEV_EDGE_CSP_EXCEPTION` can go | 1 dashboard toggle | [cloudflare-edge](infrastructure/cloudflare-edge.md#no-script-runs-unless-the-policy-names-it-2026-10-22) |
| **send the DSI the log-retention request** (the host's logs and security tooling: each kept 90 days at most, as the privacy policy promises) - the text is ready, in French | 1 e-mail | [dsi-log-retention-request](infrastructure/dsi-log-retention-request.md) |
| **set `posts=["ME"]` in Authentik for the staff accounts labelled EMSE that are ME** (two school-staff accounts), from the table Master hands over | 2 attributes | [profiles-and-access](profiles-and-access.md) |
| **raise `minClientVersion` (production and dev) each time both stores serve the latest update** - the one floor rule (owner, 2026-10-24); every item that waits on a floor waits on this gesture, the hardened v2 reader's writer flip (#2074) and a re-admitted member's window included | 1 setting per release | [the floor rule](legacy-compatibility.md#the-floor-rule-raised-when-both-stores-serve-the-latest-update-owner-2026-10-24) |
| **the DSI's go after it extends the shared host's root disk** - until then no new container is started there (2026-10-24) | blocked upstream | [host-updates](infrastructure/host-updates.md#the-root-disk-no-new-container-until-the-dsi-extends-it-2026-10-24) |
| **look at the A0 export of the Carte de la Vie Asso** once the lead has taken it (D11), and say whether the text sizes hold at print | 1 look | [the A0 export, measured 2026-11-14](carte-vie-asso.md#the-2026-09-27-audit---how-it-was-measured-and-the-eighteen-decisions-it-produced), [carte-vie-asso](carte-vie-asso.md) |
| **reset the Minesweeper ranking** (owner, 2026-11-14: *"le classement sera reset"*) when the release carrying generator 2 reaches production: the stored times were set on the easier generator-1 boards, so a generator-2 time cannot beat them - a deletion of production data (`minesweeper_scores`), so the owner's gesture or an explicit go, never the lead's alone | 1 deletion | [minesweeper](frontend/modules/minesweeper.md#generator-v2-owner-2026-11-13) |
| **delete MiConnect's unused "Local Docker connection"** (System > Outpost integrations, as an administrator; decided by the owner 2026-10-31) - its monitor fails every two minutes since the Docker socket left the worker | 1 click | [backlog.d](backlog.d/p3-miconnect-s-unused-docker-service-connection-fails-its-monitor.md) |
