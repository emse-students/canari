### Fixed - an unanswered call reads as unanswered, and a busy callee tells its caller (calls, dev builds only)

One writer for a call's record, fed a typed end reason (cancelled, declined, not answered, busy), and a typed busy answer that ends the second caller's ring at once. See [calls](docs/wiki/frontend/modules/calls.md#the-call-record-one-writer-a-typed-reason-2026-10-27).
