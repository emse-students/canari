### Fixed - the chat reel viewer shows the sender's avatar, not "UI"

The viewer opened from a reel message drew a placeholder avatar with the initials "UI" beside the right name, because the post-shaped entity it is given carried no author id. It now carries the message's sender ([reels-in-chat](docs/wiki/frontend/modules/reels-in-chat.md#7-the-work-packages-in-order)).
