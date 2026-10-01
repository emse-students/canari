### Fixed - main's CI was red on six `devalue` advisories; the lockfile now resolves 5.9.4

`devalue` (<= 5.9.2) comes transitively from `@sveltejs/kit` and `svelte`, whose ranges already admit the patched 5.9.3+, so the lockfile alone moved (`bun update devalue`) - no override, no audit ignore. `bun audit` is clean in `frontend/`.
