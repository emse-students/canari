### Changed - a Dependabot Rust bump that leaves two lockfiles stale is completed and merged by a machine

A daily job refreshes the committed `Cargo.lock` files on a new pull request opened by the `canari-auto-merge` App, and `arm-auto-merge.yml` arms it only when it is a signed Dependabot change plus lockfiles; refusals land in one issue ([cicd](docs/wiki/cicd.md#a-dependabot-cargo-bump-that-is-incomplete-by-construction-is-completed-and-merged-wp-rust-lock-automerge-2026-10-18)).
