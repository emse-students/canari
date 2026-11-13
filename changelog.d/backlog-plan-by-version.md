### Changed - every backlog entry names the version it is planned for, and the plan is generated

Each `docs/wiki/backlog.d/` entry carries `target: <version>`; `docs/wiki/plan.md` is generated from
those lines and checked by `backlog-plan.test.mjs`. The entries and readings of `backlog.md` moved
to `backlog.d/`, four of them closed with evidence ([roadmap log](docs/wiki/roadmap.md#log-of-replannings-and-milestones)).
