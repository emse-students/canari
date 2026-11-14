### Changed - a stable is refused unless it builds exactly its latest pre-release's commit

Owner, 2026-11-14: _"La stable devrait toujours etre build depuis la derniere alpha, independamment de main."_ Gate 4 now asserts it instead of trusting the resolve step; raised by `v1.6.12`, whose run read `main`'s head as its `headSha` although every arm built `v1.6.12-alpha.2` ([cicd](docs/wiki/cicd.md#the-stables-commit-is-asserted-not-only-derived-2026-11-14)).
