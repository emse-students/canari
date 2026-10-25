### Fixed - TOK-1 and TOK-2 judge the client's token renewal positively, and TOK-2 expects a cleared stage

TOK-1 now asserts one 401, one renewal, one resend and one 200 on the commit POST. TOK-2 asserts that the failed renewal clears the stage and fails the gesture, so it is no longer kept as unknown (#2420). The `[AUTH]` lines are narration on these two rows only ([cross-client-campaign-1-4-1](docs/wiki/cross-client-campaign-1-4-1.md)).
