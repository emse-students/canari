### Fixed - the first post published after an app start no longer crashes the feed page

Switching a fully mounted feed to a tab not yet loaded in the process (the publish from Pour toi lands on Campus) drew the "500" page on the iPhone: the progressive mount wrote its reset count from an effect, and Svelte 5.59 re-read the emptied list before tearing down its block. The reset is now derived ([architecture](docs/wiki/frontend/architecture.md#a-write-from-an-effect-re-runs-a-block-that-re-reads-later-svelte-559-2026-11-25)).
