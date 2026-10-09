### Changed - the host-update report's reach and the needrestart blindness are measured

The report reads the Portail-etu host, where the runner lives; `needrestart -b` is blind to an unprivileged account, so it is not wired in until a sudoers rule exists ([host-updates](docs/wiki/infrastructure/host-updates.md#what-stays-open-the-reports-reach-the-raid-channel-and-libraries-nothing-restarts)).
