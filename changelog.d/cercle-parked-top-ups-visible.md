### Fixed - a Cercle top-up parked for a member not yet signed in there is followed to its end

Canari now re-sends a parked top-up every six hours until Le Cercle answers that it is credited, then records it delivered; `/admin/cercle` lists the parked ones with their age, the weekly cleanup keeps them, a daily log line counts those waiting more than 7 days, and no status write can undo a delivery ([cotisations](docs/wiki/cotisations.md#outbound-canari---cercle-balance_topup-webhook)).
