### Fixed - main's frontend suite is green again: the chat-reel outbox test answers sends with an author proof

#2117's test fake answered `sendMessage` without the `authorProof` that #2276 made every send return, so the sent reel's row was never cleared and ten tests failed on `main`. The fake is now typed as `SentFrame`, so the compiler catches the next drift. See [reels-in-chat](docs/wiki/frontend/modules/reels-in-chat.md).
