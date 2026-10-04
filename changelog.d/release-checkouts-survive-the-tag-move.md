### Fixed - re-running a stable's release no longer fails at its first checkout

The preflight checked out the stable's tag, which the bump moves; it now names the event's commit, as the `shipped` job already does ([cicd](docs/wiki/cicd.md#a-stable-ships-the-latest-pre-release-and-main-may-move-on-2026-10-02)).
