## Reading owed - text and image blocks in a form

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

Built (owner, 2026-11-21: *"mettre un texte (description) ou un media (affiche, logo), hors d'une
question"*): the `text_block` and `image_block` items, offered under "Contenu (pas une question)" in
the add wizard, drawn by `FormBlock` on both fill pages, and question help texts rendered in the form
description's Markdown ([forms](../frontend/modules/forms.md#text-and-image-blocks-between-the-questions-owner-2026-11-21)).
No migration. Verified by unit and component tests only; nothing has been read on dev.

**The reading that closes it**, on a `1.7.3` pre-release: on dev, create a PUBLIC form with a text
block (heading, a paragraph holding `**gras**` and a `- liste`) before the first question, and an image
block (a poster, its alt text, a caption) between two questions; publish it. Open its link SIGNED OUT
in a browser: both blocks drawn in place, the image whole, the questions numbered 1, 2 with no number
on a block; send an answer. Open the same form in the app on a phone (Android and iPhone): the same.
Then, as its manager: the responses screen and the xlsx export carry no column for either block. Last,
edit the published form: move the image block with the arrows, delete the text block, publish the
change, and reload the public page.
