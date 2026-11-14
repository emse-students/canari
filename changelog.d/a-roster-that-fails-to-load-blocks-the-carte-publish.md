### Fixed - a carte roster that fails to load is no longer published empty

The carte editor drew an association whose member list failed to load as an empty one, and a publish
put that empty list on the live map. It now shows the failure with a retry and refuses to publish or
export until the list is loaded, and the server refuses an empty list for an association that has
members ([carte-vie-asso](docs/wiki/carte-vie-asso.md#rules)).
