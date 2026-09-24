### Changed - le cron que la file reclamait existait depuis le 2026-09-10

L'entree "deux des six repertoires cargo sont invisibles a Dependabot" exigeait encore un cron ;
`.github/scripts/cargo-blocked-update-report.sh` le fait depuis le 2026-09-10, branche sur le cron
du lundi avec son auto-test. Les deux moities etant livrees, l'entree part et ses deux refutations
- retirer `links`, ou desassumer les repertoires - rejoignent l'incident qu'elles concernent dans
[cicd](docs/wiki/cicd.md#and-a-manifest-can-make-a-whole-directory-invisible-to-dependabot). Au
passage, `0 4 * * 1` sert DEUX jobs et son commentaire n'en nommait qu'un.
