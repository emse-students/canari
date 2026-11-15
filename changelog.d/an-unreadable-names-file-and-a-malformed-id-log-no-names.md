### Fixed - an unreadable names file and a malformed id no longer put a name in a log

Android logged the exception MESSAGE of an unreadable `display_names.json` / `conversation_nicknames.json` (org.json quotes the whole file in it): it now logs the class. `displayName.ts` settles a malformed id for the session (no 120 s retry, one warn, the string never printed).
