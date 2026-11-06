### Fixed - the salon stored-page test no longer races a 1 s `vi.waitFor` under load

The two tests of `useConversations.salonStoredPage` now wait for the store to hold the drawn rows, queue position by queue position, instead of polling against a deadline ([testing-methodology](docs/wiki/testing-methodology.md)).
