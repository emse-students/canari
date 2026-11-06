### Changed - publishing a post closes the composer at once and the send resumes after a cut

The post and its files are kept on the device and sent in the background one file at a time, in
resumable parts, behind a progress line with a Retry; a lost answer never makes a second post, and
the next composer no longer brings back the photos just published
([posts](docs/wiki/frontend/modules/posts.md#the-background-publish-queue)).
