### Changed - the vendored-fork watch compares a fork of a pre-release with upstream's newest release

A fork of a stable stays compared with stable releases only; a fork of a pre-release
(`tauri-plugin-keystore`, now pinned exactly and watched) is compared with every release
([cicd](docs/wiki/cicd.md#a-vendored-fork-is-watched-for-upstream-releases-2026-10-21)).

### Fixed - an invitation can grant a role literally named Membre

The name is matched first; only where no role carries it does "Membre" mean the base role
([social-service](docs/wiki/services/social-service.md#an-invitation-grants-only-a-role-the-inviter-may-grant-2026-10-22)).
