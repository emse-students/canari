### Added - a voice note logs what the microphone really recorded

At the start of each recording the in-app log now carries one line: echo cancellation, noise suppression, auto gain, sample rate, channels, the class of input (Bluetooth, headset, other; never its name), and the recorder's container and bitrate. It is the measurement behind the "voice messages sound bad" report ([entry](docs/wiki/backlog.d/p2-voice-notes-are-captured-as-a-phone-call.md)); nothing about the capture changes yet.
