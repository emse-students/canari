### Fixed - one crafted credential in a key group no longer blocks revoked-device removal for every member

The client and the server now share one leaf-identity rule (`libs/contracts/leaf-identity.cases.json`): the client leaves a malformed leaf out and counts it, the server skips one instead of refusing the whole question, and logged identities have their user half cut ([mls-protocol](docs/wiki/protocols/mls-protocol.md#a-revoked-devices-leaf-is-removed-from-every-conversation)).
