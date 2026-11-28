## Reading owed - a PRIVATE MiGallery album link draws its own card (title, date, place, wide cover)

target: 1.8.4

_2026-11-28: moved to 1.8.4 when 1.8.3 shipped._

Built (2026-11-27): chat-delivery reads MiGallery's read-scoped `GET /api/albums/[id]/preview` instead of
`/info`, which became the staff's in MiGallery v2.23.1 and had turned every album card generic
([chat-delivery](../services/chat-delivery.md#who-carries-the-migallery-key-and-who-does-not)). Unit and
controller specs pin it; nothing has read it against a real MiGallery. **It needs MiGallery's own release
carrying the route** (MiGallery pull request "a read-scoped album preview").

What closes it, on the first pre-release that carries it and with MiGallery's route deployed: a link to a
PRIVATE album posted in a dev conversation shows the album's name, its date and place, and the 1200x630
cover in the banner (not the generic MiGallery card); chat-delivery's log carries no `[LINK_PREVIEW]
MiGallery` WARN or ERROR line for it. A `refused the album preview (403)` line means the dev key lacks
the read scope; `no preview route yet` means MiGallery's release is not deployed.
