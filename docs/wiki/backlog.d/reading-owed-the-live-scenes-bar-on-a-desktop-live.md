## Reading owed - the live scenes bar (one icon row) on a desktop live at two window widths

target: 1.7.0

The bar was redrawn icon-only on 2026-11-16 ([live](../frontend/modules/live.md#scenes-on-a-desktop-live-owner-2026-11-14)).
Component tests pass, but the dev server could not render a broadcaster here, so nothing has been seen.
Owed on a `1.7.0` pre-release: a desktop live on air at about 1280 px and at about 640 px wide, in
every scene including screen + camera (the second row). Read: no text on the bar, one line, no overlap
with the comment field, its send button, the reaction column or the top row; the chosen scene clearly
marked; tooltips and arrow-key focus work. Then delete this file.

**Read 2026-11-18 on dev, `1.7.0-alpha.11`, sitting S4 ([readings](../device-verification.md#the-web-rig-readings-of-2026-11-18-s4-170-alpha11-the-false-accusers-cost-and-the-web-rows)): `PASS` except the reaction column, which was not seen.** `delta` on a desktop web seat started with Chrome's fake camera and fake display capture (never a real screen), live from /posts > Publier > En direct. At about 1284 px: four icon buttons (Caméra, Écran, Écran + caméra, Je reviens), no text, `title` tooltips, one line bottom-right, clear of the comment field, its send button and the top row; the chosen scene in the accent colour and `aria-checked`; the arrow keys move the focus inside the radiogroup without changing the scene; screen + camera adds the second row (sizes, shapes). At 640 px (inner width): every scene drawn on one line, no overlap with the comment field. Seen, not filed: the camera overlay's dashed handle sits partly under the bar's two rows in screen + camera. **Left: the reaction column** (no viewer reacted during the live): a viewer seat reacting while the bar is up, at both widths.
