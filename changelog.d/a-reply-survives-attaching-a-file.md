### Fixed - a reply kept when a photo or a file is attached

Replying to a message and attaching a photo sent the photo as a plain message: the reply was consumed at the tap and only the text path read it, and a file message had no place on the wire for it. The first file now carries the reply (`MediaMsg.reply_to`) in direct messages, groups and salons, and the reply is given back if that file is refused ([chat](docs/wiki/frontend/modules/chat.md#a-reply-survives-attaching-a-file-2026-11-10)).
