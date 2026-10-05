### Fixed - a key group known only by name never asks chat-delivery for its base

A community key group whose community this session has not loaded used to fall through to chat-delivery and read its 403 as "not a member"; it now refuses as what it is ([channel-encryption](docs/wiki/protocols/channel-encryption.md)).
