### Added - a daily check that the arming App bypasses no sibling ruleset

Sky, MiGallery and Portail-etu keep the short arming step because their rulesets judge every merge; `scheduled.yml` now re-reads that setting and fails if it stops being true ([ecosystem-convergence](docs/wiki/ecosystem-convergence.md#11-the-cross-repo-convergence-plan-repo-by-repo)).
