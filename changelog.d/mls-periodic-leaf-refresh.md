### Added - periodic key refresh for post-compromise security; revoked devices are removed from conversations

Each device refreshes its own leaf in a conversation at its next send once 7 days have passed since its last commit there, only on the branch the server publishes and never during a call, and the stray-leaf collector removes the leaf of a device the server names as revoked. A commit whose submission gets no answer is now settled from the server's log instead of staying pending ([mls-protocol](docs/wiki/protocols/mls-protocol.md#the-periodic-leaf-refresh)).
