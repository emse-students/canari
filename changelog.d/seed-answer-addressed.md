### Fixed - a seed answer reaches only the device that asked, from one device of the answerer

An answer to a seed request was queued for every seat of the community and sent by every online device of the answerer; it is now addressed to the requesting device and kept out of the history stream, and each ask logs why it was made ([channel-encryption](docs/wiki/protocols/channel-encryption.md#23-a-seed-answer-goes-to-the-device-that-asked-from-one-device---fixed-2026-10-12)).
