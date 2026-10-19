### Changed - the server no longer sends a typing signal back to the person typing

The client dropped it on arrival, so it was one frame per keystroke burst for nothing. Failed typing sends now log once per failing streak, and reactions and edits received in a channel each leave one line.
