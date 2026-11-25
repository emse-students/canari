## Reading owed - text and image blocks in a form

target: 1.8.2

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

_2026-11-25: moved to 1.8.1 when 1.8.0 shipped._

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

**2026-11-22, `1.8.0-alpha.1` triage (readings rule).** Web half PASS on dev (2026-11-22): a public form with a text block, a question, an image block, a question; signed out, both blocks draw in place, the image whole (640x360), the questions numbered 1 and 2 with no number on a block, bold and list rendered; an answer was sent; the manager's list carries only the question's answer and the xlsx export has no column for either block; after the blocks were reordered and the text block deleted (through the API, not the editor's arrows) the public page followed. Left: the same form in the app on the Mi 9T and the iPhone 12, and the editor's arrows in a browser. Dev form `f07f5c01-ad63-4fcd-acc6-aed213d2653d`.

**2026-11-23, [`1.8.0-alpha.2`](../device-verification.md#the-readings-of-2026-11-23-180-alpha2-the-resume-with-salons-the-share-shortcuts-the-keyboard-on-a-photo-dm-the-inactive-iphone) (iPhone 12): the app half PASS on the iPhone.** The text block draws in place from the chat link card, bold and list included, with no number on the block. Left: the Mi 9T and the editor arrows in a browser.

**2026-11-23, `1.8.0-alpha.3` (Mi 9T): the app half PASS on Android.** The dev form with the image block and two questions (the poster whole with its caption, the questions numbered 1 and 2 with no number on the block) and the form with the text block (a heading, a bold word, a two-item list, the question numbered 1, the counter reading 0 of 1) draw in place in the app. **Left:** only the editor's arrows in a browser.

**2026-11-23, `1.8.0-alpha.3` ([iPhone 12 sitting](../device-verification.md#the-readings-of-2026-11-23-180-alpha3-iphone-12-the-resume-from-settings-the-pushes-name-and-logo-the-banners-the-share-logos-the-ios-27-launch)): the iPhone image block PASS.** A form with an image block and two questions: the poster whole with its caption, the questions numbered 1 and 2, no number on the block, the counter reading 0 of 2. **Left:** only the editor's arrows in a browser.

**2026-11-25, `1.8.1-alpha.2` (Mi 9T): the Mi half PASS.** The poster image block is whole with its caption, the questions are numbered 1 and 2 (not the block), the counter reads 0/2. **Still owed:** the editor's move arrows in a browser.
