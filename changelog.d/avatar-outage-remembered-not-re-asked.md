### Fixed - a gallery outage no longer makes every avatar be asked for again on each remount

A face the avatar source answered 5xx for is remembered per user for the life of the outage (one warn per outage, not per face) and ends on an event - any avatar answered, the link or app coming back, a navigation, a reader change - never on a clock ([core-service](docs/wiki/services/core-service.md#the-avatar-proxy)).
