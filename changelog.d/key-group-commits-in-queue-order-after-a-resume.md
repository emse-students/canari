### Fixed - after a resume, no key-group commit jumps the seeds still queued before it

A live seed, a community's epoch check and a refused key-group commit each stepped the commit log
while the reconnect's pull had not yet listed the mailbox, so queued seeds more than two epochs behind
were lost for good. They now wait for this link's drain, and the window stays 2
([channel-encryption 22.2](docs/wiki/protocols/channel-encryption.md#222-after-a-resume-no-key-group-commit-is-applied-ahead-of-the-frames-queued-before-it-2026-11-04)).
