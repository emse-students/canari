### Fixed - every pull request and main went red when GitHub withdrew the picomatch advisory

GitHub withdrew `GHSA-fc5q-39xc-vjpf` on 2026-11-18, so the audit stopped reporting it and the step that retires dead ignores failed everywhere, as designed. The ignore, its premise script and its assertions are deleted ([cicd](docs/wiki/cicd.md#the-audit-blocks-on-what-we-ship-2026-11-17)).
