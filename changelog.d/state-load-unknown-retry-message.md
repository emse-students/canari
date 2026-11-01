### Fixed - an unexplained failure to open the local data no longer tells the user to reset

When the saved state failed to load for a cause nothing typed (an IPC fault, a disk read, a panic), the login said the data was damaged and only a reset restored access. It now says to close and reopen the app or retry, and that nothing is lost; the damaged-state sentence stays for the causes that prove damage. See [mls-protocol](docs/wiki/protocols/mls-protocol.md).
