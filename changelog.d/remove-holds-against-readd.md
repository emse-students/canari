### Changed - a member removed from a group conversation and added back no longer receives what was sent while they were out

The server records membership intervals (migration 029) and every history answer withholds the windows of the group's current members, by server time (user, 2026-10-14) ([history-reconciliation](docs/wiki/protocols/history-reconciliation.md#a-remove-holds-against-a-later-re-add---the-answering-peer-withholds-the-window-decided-by-the-user-2026-10-14)).
