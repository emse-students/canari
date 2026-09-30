### Security - brace-expansion 5.0.12 in all five trees

Three new advisories (GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p, GHSA-q2hr-2g5m-vwhr) failed the dependency
audit of every tree, so `CI passed` was red on every pull request. The `overrides` floor moves from 5.0.6-5.0.9
to `^5.0.12` in each `package.json`, the same mechanism the earlier advisories used.
