### Fixed - a device that just joined a group no longer receives the frames sealed before its join

A frame sealed at an epoch before a device's admission could never be opened by it, and was
acknowledged as a lost key-group frame followed by needless seed requests. chat-delivery now
withholds it from that device ([chat-delivery](docs/wiki/services/chat-delivery.md#who-a-frame-is-queued-for-and-who-owns-the-gateways-routing-set)).
