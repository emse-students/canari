## Reading owed - the Thème control's "Automatique" label and the feed's tabs at a doubled font

target: 1.8.1

**Fixed in code by #3849** (`SettingsPreferencesSection.svelte`: the label span carries
`[overflow-wrap:anywhere] break-words hyphens-auto`, and `SettingsPreferencesSection.controlRows.svelte.test.ts`
asserts it; `FeedTabRow.svelte`: tabs are `flex-auto` and may shrink). The original defect was read on
`1.7.1-alpha.3`, Mi 9T, Settings > Préférences at `font_scale` 2.0
([S9](../device-verification.md#the-phone-readings-of-2026-11-19-s9-171-alpha3)): "Automatique" ran past its
segment over "Sombre", and "Campus" left the right edge of the feed's tab row. happy-dom has no layout, so
only a phone settles it.

**The reading that closes it:** the same screen at `font_scale` 2.0 on the Mi 9T, every label inside its own
segment, and the feed's three tabs inside the screen. Delete this file on a pass.

**2026-11-25, `1.8.1-alpha.2` (Mi 9T, `font_scale` 2.0, 436 CSS px): the theme control PASS, the feed tabs FAIL.** "Auto-matique" is hyphenated inside its segment. But the `min-w-min` floor of the earlier fix made the row overflow, the selected middle tab was centred, and "Organisations" slid under the start fade (button `left` -7, drawn "rganisations"). **Fixed (`fix/feed-tabs-at-doubled-font`):** a tab is `min-w-0 flex-auto` with the theme control's `[overflow-wrap:anywhere] break-words hyphens-auto`, so no tab can exceed the row at any font scale and the row never needs to scroll ([design-reference](../frontend/design-reference.md)). **The reading owed on the next alpha:** the feed's three tabs at `font_scale` 2.0 on the Mi 9T, every label whole and inside the screen.
