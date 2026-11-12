### Fixed - the chat's crash line names the error; a mention ended before its search no longer reopens the picker

Typing "@" in a DM or a salon looped the mention picker's effect on `1.6.6`-`1.6.8` (fixed by #3233 in `1.6.9`); a key-by-key test now pins it. The chat boundary logs the error's name, message and stack instead of `[object Object]`, and a pending name search is dropped when the mention ends ([chat](docs/wiki/frontend/modules/chat.md)).
