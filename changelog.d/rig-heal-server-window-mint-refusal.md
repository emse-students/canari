### Changed - the HEAL rungs count the server as an observer, and a full account is an INVALID everywhere a device is minted

A dirty server window now demotes a HEAL PASS and enters `clean`; rows without `serverClean` are listed by `bun rows.mjs` as never having observed it, and every `becomeANewDevice` caller reads `refused` - rig only, see [cross-client harness](tools/cross-client-harness/README.md).
