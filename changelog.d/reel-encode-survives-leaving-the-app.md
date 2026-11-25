### Fixed - a CanaReel whose video encode is cut by leaving the app is kept and prepared again on return

On the iPhone, Home pressed about a second after "Publish" stopped the hardware encoder and the post ended at "Failed". An encoder failure while the app was out of view is now the `interrupted` fault, typed at the throw from the lifecycle edges, and the publish queue keeps the post and prepares it again when the app is back in view ([posts](docs/wiki/frontend/modules/posts.md#the-background-publish-queue)).
