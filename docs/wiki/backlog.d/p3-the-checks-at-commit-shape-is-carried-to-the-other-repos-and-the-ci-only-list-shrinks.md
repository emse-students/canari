## P3 - The checks-at-commit shape is carried to the four other repos, and the CI-only list shrinks (2026-11-15)

target: 1.10.0

The owner decided on 2026-11-15 that what a pull request checks is checked at commit and at push
([cicd](../cicd.md#checks-at-commit-at-push-and-in-ci-only)). Canari has it; three things are left:

1. **Sky, MiGallery, Portail-etu and Le Cercle** keep their own hooks. The same shape - one scope
   script and one command script that CI and the tracked hooks both call, a pre-push that merges
   `main` first, `core.hooksPath` on a tracked directory - is carried once it has run here for a
   release ([ecosystem-convergence](../ecosystem-convergence.md#6-the-gates-and-whether-anything-runs-them)).
2. **Three CI-only jobs could run on a workstation with Docker or an SDK, and were not measured
   there**: `test-miconnect-blueprints` (Authentik in Docker), `compile-android-app` (Android SDK
   and NDK) and the integration specs on PostgreSQL. Each moves to the push tier the day it is
   measured green on Windows and Linux, through `checks.sh`, or its reason stays in `JOB_TIERS`.
3. **`deploy-rolling.test.sh` does not run under Docker Desktop.** Two runs on the Windows
   workstation (2026-11-15) failed on two different cases - its DNS-name control saw no failure,
   then one `ConnectionRefused` in 44502 POSTs across 450 reloads - while CI's Linux engine is
   green. Whether the second is Docker Desktop's network or a gap a Linux run can also hit is
   unknown; the test runs again here the day that is answered.
