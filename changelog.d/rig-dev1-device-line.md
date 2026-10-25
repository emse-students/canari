### Fixed - DEV-1 counts the device line in the open conversation, and only on the contact

DEV-1 counted "a ajouté un appareil" across the whole page and expected it on the owner too. The owner is told by the account notice and gets no line. A contact gets the line in every conversation it shares with the owner, so its sidebar previews read eight. The line is now counted in the open pane: once on W2, none on W1 ([campaign](docs/wiki/cross-client-campaign-1-4-1.md)).

`purge-devices.mjs` and the PIN row now open `/settings/security`. `/settings` has been a hub since #1699, so every DEV revoke exited 1 before reaching the panel.
