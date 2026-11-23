## P2 - A post's pictures and videos: the layout from one to many, designed (owner, 2026-11-15)

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

**Owner, 2026-11-19:** a post with several pictures or videos shows a CAROUSEL with a counter (as
Instagram); a single one shows at its own shape ([decisions](../decisions/owner-decisions-of-2026-11-19.md)).

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](../decisions/owner-decisions-of-2026-11-17.md))._

The second half of the owner's decision "Une seule famille de cartes" of 2026-11-15. The first half
shipped as the card zone - one card family for every non-media attachment, the fixed order text,
media, cards, poll, action bar, a form drawn once, the hero for a lone attachment
([posts](../frontend/modules/posts.md#the-card-zone-one-family-a-fixed-order-owner-2026-11-15)). What
is left is the media block itself, which the owner asked to be thought through: *"un truc beau,
coherent et pratique"*.

What exists ([posts](../frontend/modules/posts.md#several-media-square-cells-and-a-n-past-four-2026-10-05)):
one picture at its own shape under the `--media-max-height` ceiling; two side by side; three as one
large square and two stacked; four as 2x2; more as 2x2 with a "+N" veil; every cell square, a video
cell cropped; the viewer swipes through all of them; a tap on a video opens the CanaReels viewer.

To decide and build, against Instagram for the feed and the Messenger/Facebook numbers of
[design-reference](../frontend/design-reference.md):

- one to five-plus pictures: keep the grid, or a swipeable carousel with a counter (Instagram), and
  where the "+N" belongs; the feed and the post page may differ;
- portrait, landscape and square: the first picture's shape setting the block, or a fixed 4:5;
- a video in a grid: its poster, a duration badge, muted autoplay or not;
- the after-shots owed for: a lone image, 2, 3, 4 and 6 images, a mix of image and video, at 390 and
  1080 px.

Reading owed with it, on both phones: the card zone of the first half (a lone link, a lone PDF, the
combined post of the 2026-11-15 shots), feed and post page.
