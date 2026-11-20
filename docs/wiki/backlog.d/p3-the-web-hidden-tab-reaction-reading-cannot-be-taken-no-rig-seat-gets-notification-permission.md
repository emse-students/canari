## P3 - harness: the web hidden-tab reaction reading cannot be taken, no rig seat can get `Notification.permission` granted (S17, 2026-11-20)

target: 1.7.3

Owed since `1.7.1`, met again in sitting S17 of 2026-11-20: the reading of a reaction arriving in a HIDDEN web tab needs `Notification.permission` to be `granted`, and no rig seat gets it: `Browser.grantPermissions` and `setPermission` both answer `{}` and change nothing. Find a way the rig can hold the permission (a browser profile created with it granted, a launch flag or policy for the harness browser, or a seat that has answered the real prompt once and keeps its profile), document it in [the harness README](../../../tools/cross-client-harness/README.md), then take the reading.
