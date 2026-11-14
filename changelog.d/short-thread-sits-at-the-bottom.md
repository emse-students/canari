### Fixed - a short conversation sits at the bottom and loads its past when it opens, not when the keyboard closes

A DM shorter than the screen drew its rows at the top. On the first stray scroll it also started its
older-history load, and a keyboard close was such a scroll: the spinner showed and the thread jumped
twice ([chat](docs/wiki/frontend/modules/chat.md#a-short-thread-sits-at-the-bottom-and-asks-for-its-past-at-entry-2026-11-14)).
