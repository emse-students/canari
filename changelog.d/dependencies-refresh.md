### Changed - dependency lockfiles refreshed on every service

The four NestJS services, the frontend and the Rust crates moved to the newest versions their ranges allow (no majors); `svelte-check` 4.7.7 refuses `$props<T>()`, so its two uses became `}: T = $props()` ([cicd](docs/wiki/cicd.md#dependency-updates-and-the-auto-merge-that-ships-them)).
