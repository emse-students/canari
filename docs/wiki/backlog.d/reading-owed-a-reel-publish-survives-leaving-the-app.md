## Reading owed - a CanaReel publish survives the screen sleeping and the app being left

target: 1.8.0

Built 2026-11-24: the CanaReels camera's "Publier" queues the take in the background publish queue,
and the screen stays on while a post is worked on ([reels](../frontend/modules/reels.md#publishing-r3-on-c2-and-c3),
[posts](../frontend/modules/posts.md#the-background-publish-queue)). Unit tests pin the resume after a
cut at each step and the single create; the phone has not been read.

The reading, on the Mi 9T with battery saver ON and a throttled link: (1) record a reel, press
"Publier", put the phone down without touching it - the screen must stay on while the banner says
"Envoi" and go to sleep once nothing is sent (`[PUBLISH-QUEUE] screen held on` / `released`); (2)
record another, press "Publier", leave the app mid-upload (home button), come back after a minute -
the banner resumes from its part and the reel is published ONCE (one `[PUBLISH-QUEUE] <id> published`,
one card in the feed); (3) the same with "Envoyer a..." and a conversation ticked - one upload,
the chat bubble plays the published file (`adopts` in the log). The iPhone 12 reads (1) and (2).
