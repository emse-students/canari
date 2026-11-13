### Fixed - the pin register belongs to one account

A conversation's pins were stored under the conversation alone, so two accounts on one install
shared them, and neither a sign-out nor an account deletion removed them. They are now stored per
account, forgotten at sign-out and swept with the account; the old copy moves to the first account
that reads the conversation ([legacy-compatibility](docs/wiki/legacy-compatibility.md)).
