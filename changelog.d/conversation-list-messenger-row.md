### Changed - the conversation list reads like Messenger's: 72 dp rows, 56 dp avatars, a time on the name line, a neutral search pill

Rows go from 78 to 72 dp and avatars from 48 to 56 dp; the relative time of the last message sits right-aligned on the name line (the existing `timeAgo`), and an unread conversation is bold in its name, time and preview. The search sits on an opaque neutral band instead of a translucent navy one, and the field is a 40 dp filled pill with no border ([design-reference](docs/wiki/frontend/design-reference.md)).

The time label advances on its own every minute through one shared tick (`minuteClock.svelte.ts`), and the row and search focus rings use the `cn-yellow` token instead of raw amber.
