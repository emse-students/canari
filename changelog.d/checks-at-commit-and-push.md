### Changed - what a pull request checks is checked at commit and at push

The pre-commit hook adds fast checks scoped to the staged paths; a new pre-push hook merges the
latest origin/main and runs every check a workstation can run, through the same scripts as CI. The
hooks are the tracked `.husky/` files, so a fresh worktree runs them too
([cicd](docs/wiki/cicd.md#checks-at-commit-at-push-and-in-ci-only)).
