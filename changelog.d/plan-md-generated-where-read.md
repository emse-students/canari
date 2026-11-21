### Fixed - the plan page no longer makes every open pull request conflict

`docs/wiki/plan.md` is generated in every checkout by the git hooks and never committed: committed,
every merge to `main` left the other open pull requests conflicting on it and their automatic merge
stalled ([cicd](docs/wiki/cicd.md#the-plan-page-is-generated-where-it-is-read-2026-11-16)).
