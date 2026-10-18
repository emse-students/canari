### Fixed - a PIN change asked from a follower tab is refused up front instead of ending in a recovery prompt

The change now runs from the account's active (leader) tab only, and a follower says so before the server is asked anything ([auth](docs/wiki/frontend/modules/auth.md#the-other-tabs-of-the-account)).
