### Changed - a push registration is bound to the session that made it

Ending a session now deletes exactly the push registration that session wrote, recorded in the same transaction as the session's deletion and retried until chat-delivery confirms it ([sessions](docs/wiki/sessions.md#a-session-that-ends-takes-its-devices-push-registration-with-it-2026-10-22)).
