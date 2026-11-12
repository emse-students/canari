## P2 - the repository holds GitHub's maximum of 100 secrets, so the next one is refused

Measured 2026-11-11: `gh api repos/emse-students/canari/actions/secrets` reads `total_count: 100`,
and GitHub answers a further `gh secret set` with a bare HTTP 400. The handoff's reader token
(`MICONNECT_READER_TOKEN`) was therefore set as a secret of the `production` ENVIRONMENT: the only
job that reads it, "Deploy to Production Server" in `serve-prod.yml`, declares `environment:
production`, so the same `secrets.` expression resolves it, and an environment secret does not count
toward the repository's 100 ([cicd](../cicd.md)).

**The reform, decided 2026-11-11 (owner: workflows may change if tidying needs it).** An inventory
read every reader job of each secret:

1. **Phase 1** - the 32 `DEV_*` secrets read only by the dev deploy move to the `development`
   environment under the same name, values re-supplied from the dev estate, no workflow change. The
   repository copies are deleted only after a pre-release deployed dev green from the environment
   copies.
2. **Phase 2** - the 36 secrets read only by the production deploy move to `production` the same
   way, proven by the next stable before the repository copies go.
3. **Phase 3, decided after phase 2** - the build jobs get an `environment:` of their estate, so the
   same names exist in both environments and the `DEV_` prefix becomes structural.

What stays at repository level for good: the CI and release secrets (auto-merge, Dependabot,
Android, Apple and Play signing) and the values a build job shares with production. `JWT_SECRET`
was in the mobile builds' presence check without being built into either app; it left that check on
2026-11-11, so it is production-only and joins phase 2.

Closed when phases 1 and 2 are done and `total_count` reads at most 40.
