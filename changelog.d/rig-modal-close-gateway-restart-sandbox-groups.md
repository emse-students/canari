### Fixed - the rig closes the add-members modal by its own control, cuts sockets by restarting the gateway, and can mint sweepable sandbox groups

`closeOverlays` addresses the modal backdrop's close button, `addPeer` fails loudly when the picker offers nobody, `restartGateway()` replaces `adb reverse --remove` (which never cut an open socket) and `newgroup.mjs --sandbox` mints a shape `cleanup.mjs` may sweep ([harness README](tools/cross-client-harness/README.md)).
