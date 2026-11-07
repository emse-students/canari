### Added - a call reports a video codec negotiated against its transform's

WebKit's frames name no codec, so an engine ignoring `setCodecPreferences` would have carried H.264 framed as VP8 unseen; once negotiation settles, each video side's negotiated codec is now compared with its transform's and a mismatch is logged once, at ERROR (a report only). The iOS app also leaves the Media Session `hangup` alone when clearing, as CallKit owns it. See [calls](docs/wiki/frontend/modules/calls.md#the-iphone-and-android-framed-video-differently-production-2026-11-07).
