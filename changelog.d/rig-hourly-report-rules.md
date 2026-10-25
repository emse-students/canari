### Fixed - the test rig reads two hourly server reports as reports

The commit-rate rule expected a `,` where the server writes `;` and had matched no real line since it was written, and the TURN meter's hourly reading was never classified, so any report landing in a row's window made it read dirty (CC-3 on alpha.4); both are notable now, and a busy group or a reached TURN budget stays a finding (`tools/cross-client-harness/srvlog.mjs`).
