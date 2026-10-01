### Changed - a video is re-encoded on the phone before a post or a chat message sends it

The post composer, the post editor and the chat composer prepare every picked video with
`prepareVideoForUpload`, showing its progress with a cross that stops it; a video is no longer
refused for its picked size ([video-preparation](docs/wiki/frontend/video-preparation.md)).
