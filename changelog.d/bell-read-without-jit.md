### Fixed - the notifications bell answers in milliseconds again, not 1-13 s

PostgreSQL was JIT-compiling the bell's large visibility statement on every poll for heavy readers; every social-service connection now starts with `jit=off` ([posts](docs/wiki/frontend/modules/posts.md#the-bell-re-checks-the-post-review-of-2965-2026-11-03)).
