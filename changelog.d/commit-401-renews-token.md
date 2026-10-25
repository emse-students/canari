### Fixed - a commit answered 401 renews the token and is sent again, instead of ending the Add

Every MLS delivery request now obeys the one 401 rule of every first-party call: renew, send the same bytes once more, a logout only when the renewed token is refused too ([sessions](docs/wiki/sessions.md#a-401-renews-the-token-and-sends-the-same-request-once---one-rule-every-caller)).
