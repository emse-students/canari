### Fixed - three guards that failed open now fail closed

`call-service` refuses to start without `CALL_ROOM_SECRET` and no longer defaults a TURN password; core and social require `INTERNAL_SHARED_SECRET` and the HMAC in every environment, not only production. Every estate already set both ([core-service](docs/wiki/services/core-service.md#three-services-refuse-an-unsigned-caller-three-different-ways), [call-service](docs/wiki/services/call-service.md)).
