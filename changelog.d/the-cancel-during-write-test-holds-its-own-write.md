### Fixed - the cancel-during-the-write test now really lets the write land

The test asserted inside the storage hook, so the outbox swallowed a 20 s timeout and the write failed every run; the test now holds and releases the write itself and asserts the session release ([reels-in-chat](docs/wiki/frontend/modules/reels-in-chat.md)).
