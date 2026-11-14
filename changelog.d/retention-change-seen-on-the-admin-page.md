### Fixed - a retention change that media-service did not take is now seen on the admin page

`/admin/platform` says "pas encore appliqué aux fichiers" with "Renvoyer" while media-service holds other durations than the ones saved; a social-service outage is logged once when it starts and once when it ends, not per upload; the privacy page's cached notice says only "valeurs du <date>" ([retention-settings](docs/wiki/retention-settings.md#media-service-holds-the-durations-it-stamps)).
