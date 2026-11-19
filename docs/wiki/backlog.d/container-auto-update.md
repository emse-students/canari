## The server images keep themselves up to date: pinned digests, Dependabot, a server-only release and a weekly scan

target: 1.8.0

**Owner, 2026-11-19:** the weekly scan of the deployed images TRIGGERS the server-only release by itself for a digest bump (a rebuilt image of the same version, with its health check and automatic rollback); anything larger opens an issue ([decisions](owner-decisions-of-2026-11-19.md)).

Decided by the owner on 2026-11-16, after the image scan blocked a release on base-image findings
nobody had been told about ([cicd](../cicd.md)). The goal: a vulnerable base image is replaced without
a human noticing it first, and without shipping the stores for a server-only change.

- **Every `FROM` and every compose `image:` pinned by digest** (`name:tag@sha256:...`), so what runs is
  exactly what was scanned, and **Dependabot** (the `docker` and `docker-compose` ecosystems) opens the
  digest bumps, armed for **auto-merge** like any pull request once `CI passed` is green.
- **A server-only release kind**: the server images rebuilt and deployed WITHOUT a store build or a
  version bump of the apps, behind a **health check** after the deploy and an automatic **rollback** to
  the previous images when it fails - one more kind in `release_kind()`
  (`.github/scripts/lib/release-preconditions.sh`), never a second release workflow.
- **A weekly scan of the DEPLOYED images in `scheduled.yml`** (no fifth visible workflow): a finding
  with a fixed version either triggers the server-only release (the fix is a digest bump already
  merged) or opens ONE deduplicated issue (one per image and finding, updated rather than reopened).
- **Every scan exception carries a re-check date**, and an exception past its date fails the scan
  until it is renewed or removed.

**State, read on 2026-11-19.** Done: Dependabot's `docker` and `docker-compose` ecosystems are configured
(`.github/dependabot.yml`) and have opened digest bumps (#3726, #3727); some compose `image:` lines
are digest-pinned (garage and coturn are not). **Still owed:** the Dockerfile `FROM` lines are tags (one
of them carries a digest), the server-only release kind does not exist in `release_kind()`, there is no
weekly scan of the deployed images in `scheduled.yml`, and no scan exception carries a re-check date.
