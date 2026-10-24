### Fixed - a resubmitted commit the server already accepted is no longer refused as an epoch conflict

The commit gate checks its log for these bytes from this device before every epoch or seat refusal, not only at the strict gate. Before, a key-group Add or a resubmission that overlapped its own first request was refused, and the client dropped a commit the group had applied ([mls-protocol](docs/wiki/protocols/mls-protocol.md)).
