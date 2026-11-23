### Fixed - the lives_mode relay line is logged when the mode changes, not on every live segment

social-service remembers the last mode it relayed to media-service and logs only a change (or the first
answer of a process) ([lives](docs/wiki/services/lives.md#the-two-switches-live_enabled-and-lives_mode)).
