### Changed - DUP-2's intervening commit is a Remove, because a second Add is refused at the add lock

W1's held Add keeps the group's add lock, so the planned intervening Add was refused ('Add-lock busy') and DUP-2 could not be played; W4 now Removes W5 beside the held Add, and an intervening Add during a held resubmission is CC-1's case ([cross-client-campaign-1-4-1](docs/wiki/cross-client-campaign-1-4-1.md)).
