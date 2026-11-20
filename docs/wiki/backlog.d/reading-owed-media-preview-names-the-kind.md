## Reading owed - the conversation list names a media message by its kind (owner, 2026-11-20)

target: 1.7.2

Built: a conversation whose last message is a photo, video, voice note, GIF, file or CanaReel now
previews as `Photo`, `Vidéo`, `Message vocal`, `[GIF]`, `Fichier : <nom>`, `CanaReel` (caption
appended) instead of `[Média]`, through ONE function for the list, the reply quotes and the in-app
notification body ([chat](../frontend/modules/chat.md#a-media-message-is-previewed-by-what-it-is-2026-11-20)).

The reading that closes it, on a phone: send each kind to a bench account and read the list row of
that conversation in French and in English; reply to a photo and read the quote above the reply; and
background the app so the in-app notification path words a photo. No phone reading has been taken.
