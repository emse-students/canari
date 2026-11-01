### Fixed - an Android salon notification names its sender and shows their face or initials

A salon banner named nobody and drew the salon's first letter as its face. It now names an author
only when the message's opening proved who wrote it (a v2 session), using the phone's own copy of
names and never the push. Otherwise it says "Quelqu'un". The push and the live connection give the
same answer for the same message, whichever arrives first
([mobile](docs/wiki/frontend/mobile.md#a-mention-names-its-author-from-the-phones-own-copy-wp-mention-name-2026-10-18)).
