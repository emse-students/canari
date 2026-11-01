### Fixed - call log noise on the iPhone, a salon page that could not be stored, and an unreadable sound-gate line

The earpiece is the default output of a call and is no longer looked up as a device that WebKit never lists, the voice's priming play is no longer logged when the stream's arrival aborts it, a hang-up no longer logs a signalling error, a Media Session refusal is said once per page, and a salon's first page writes its conversation row before its messages (foreign key). The sound-gate lines now enter the in-app log (`Log.i`). See [calls](docs/wiki/frontend/modules/calls.md).
