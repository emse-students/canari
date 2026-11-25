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
