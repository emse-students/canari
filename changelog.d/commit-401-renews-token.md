### Fixed - a commit answered 401 renews the token and is sent again, instead of ending the Add

MLS delivery requests now follow the 401 rule of first-party calls: renew, send the same bytes once more within the request's deadline. A renewed token refused again is a failed request, never a logout ([sessions](docs/wiki/sessions.md#a-401-renews-the-token-and-sends-the-same-request-once---one-rule-every-caller)).
