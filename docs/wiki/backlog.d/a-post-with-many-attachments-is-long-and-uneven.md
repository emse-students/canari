## P3 - a post with many attachments is long and uneven (owner, 2026-11-13)

**Observed** (owner, web feed, a BDE post): text, a link card, a full-width image, then a PDF card
with its own preview, stacked one under the other. The post is very tall, and each block has its own
width and frame: the link card is inset with a border, the image is edge to edge, and the document card
is inset again with a cover drawn at yet another width. *"Ça prend beaucoup de place, et c'est moche,
avec plein de largeurs différentes."*

**Made worse on purpose by #3472**: a post now previews EVERY distinct link, not only the first (owner's
request of the same day). A post naming three links therefore draws three cards before its media.

**What a fix has to decide** (not built, not urgent):
- **One width.** Every attachment block (link cards, media, documents) shares one inset and one frame, or
  every one runs edge to edge. Never a mix. The measured target is in
  [design-reference](../frontend/design-reference.md).
- **Compact link cards when there are several.** A single link keeps today's card. Two or more could
  become one compact list (favicon, title, domain, one line each), or a horizontal strip.
- **A document's cover is not a second image.** A PDF shows as a one-line file row (name, size,
  download), and its cover opens on tap. Drawing it at full size doubles the height of a post that
  already has a photo.
- **The order.** The media first, then the documents, then the links? Or the order the author wrote them
  in? To be read against Instagram and Facebook
  ([design references](../frontend/design-reference.md)).

**Closes with** one PR changing `PostContent` (and `LinkPreviewCard` and the document card) to the one
width and the compact forms. It needs a before/after screenshot of this post at 390 px and at desktop
width.
