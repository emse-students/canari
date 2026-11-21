### Changed - the welcome-request-pending push can go content-free (switch off)

With `push_mode = wake`, a device declaring version 2 now receives this push as a silent wake and fetches its ids from our server, so Google and Apple no longer see which person's device joins which conversation. No client declares version 2 yet ([content-free push](docs/wiki/protocols/content-free-push.md#2-the-target)). It is no longer sent to iPhones at all, which never acted on it.
