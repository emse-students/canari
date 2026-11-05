### Fixed - a reply in a group no longer prints the sender's name twice

Under the sender's name, the caption now reads "A répondu à <quoted author>" (or "A répondu à son message"); own messages and 1:1 keep the full form, and an unknown author gets a name-less form, never an id ([#3046](https://github.com/emse-students/canari/pull/3046), [chat](docs/wiki/frontend/modules/chat.md)).
