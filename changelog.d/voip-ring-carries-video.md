### Fixed - the iPhone's native ring announces a video call as video

The VoIP push now carries the call's media kind and CallKit announces it, so answering a video call joins with the camera ([calls](docs/wiki/frontend/modules/calls.md)). Older iPhone builds ignore the new value and ring as audio, as before.
