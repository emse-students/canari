### Fixed - the Graine rig reads the server's refusal of an unsigned row

The server's refusal of an unsigned salon row (#1802) broke the rig's v1 arm, which posted one. GRAINE-AUTH-7 now reads the 400, GRAINE-AUTH-6 writes its row in the database, and GRAINE-AUTH-5 has no arm ([cross-client-testing](docs/wiki/cross-client-testing.md#20---graine---an-author-that-is-proven)).
