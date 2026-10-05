### Fixed - an Android phone now flushes its MLS state when backgrounded and reconnects on return

A backgrounded Android WebView never fires `visibilitychange`, so the persister, the socket reconnect and the login reset also listen to the native foreground edge; the coupled background/resume sequence is owed one device run ([backlog](docs/wiki/backlog.md)).
