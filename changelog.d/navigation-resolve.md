### Changed - every navigation goes through `resolve()`, and the lint rule that enforces it is on

The ~100 `goto()` and `href` calls now carry the base path, so the app survives being served under a prefix; `svelte/no-navigation-without-resolve` is no longer disabled ([backlog](docs/wiki/backlog.md#p3---108-navigations-bypass-resolve-92-here-16-on-migallery-counted-2026-08-27-and-an-inherited-disable-is-the-only-reason-nobody-sees-them)).
