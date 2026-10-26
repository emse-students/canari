### Fixed - a cotisation tier is bought only as a rise over the one held

A holder of a tier can no longer buy a cheaper or equally priced sibling tier (`TIER_NOT_A_RISE`), which used to replace it silently, nor their own tier again; the shop listing now says where each tier stands and what it would charge ([cotisations](docs/wiki/cotisations.md#rising-to-a-higher-tier)).
