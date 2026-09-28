### Fixed - the dev server failed at random with `MediaService` read before initialization

Eight modules imported `appendLog` from the chat singleton, which builds the session while it loads; it lives in a module of its own now, and a test forbids the cycle ([durable-rules](docs/wiki/durable-rules.md)).
