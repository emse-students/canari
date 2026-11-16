## Reading owed - the live scenes bar (one icon row) on a desktop live at two window widths

target: 1.7.0

The bar was redrawn icon-only on 2026-11-16 ([live](../frontend/modules/live.md#scenes-on-a-desktop-live-owner-2026-11-14)).
Component tests pass, but the dev server could not render a broadcaster here, so nothing has been seen.
Owed on a `1.7.0` pre-release: a desktop live on air at about 1280 px and at about 640 px wide, in
every scene including screen + camera (the second row). Read: no text on the bar, one line, no overlap
with the comment field, its send button, the reaction column or the top row; the chosen scene clearly
marked; tooltips and arrow-key focus work. Then delete this file.
