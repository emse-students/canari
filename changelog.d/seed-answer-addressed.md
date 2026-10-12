### Fixed - a seed answer reaches only the device that asked, instead of the whole community

An answer to a seed request was queued for every seat of the community. It now goes to the requesting device alone and stays out of the history stream. The request names the devices of the answerer that can read it, a member counts as declined only once each of those devices has declined, and every ask logs why it was made ([channel-encryption](docs/wiki/protocols/channel-encryption.md#23-a-seed-answer-goes-only-to-the-device-that-asked---fixed-2026-10-12)).
