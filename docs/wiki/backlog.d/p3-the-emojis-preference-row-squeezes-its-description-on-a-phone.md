## P3 - the Emojis preference row squeezes its description into a five-word column on a phone

target: 1.7.0

Read on the iPhone 12 (390 pt wide), Settings > Preferences, 2026-11-15, found while reading the menus entry. The "Emojis" row of `SettingsPreferencesSection.svelte` keeps its label and description beside a two-segment control fixed at `w-44 shrink-0`, so the description ("Systeme : ceux de votre telephone. Canari : les memes dessins sur tous les appareils.") wraps to ONE to three words per line and runs eleven lines down the screen, while the Theme row just above it puts its three-segment control UNDER its text and reads cleanly. Nothing is cut or unreachable; it is a layout wart, not a loss.

The fix is the Theme row's shape (control below the text on a narrow width, beside it from `sm`), and the same look at the other rows of that page that pair a long description with a fixed-width control (Activity sharing, reposts), at 390 pt and at a doubled root font ([design-reference](../frontend/design-reference.md)). A screenshot at 390 pt is the closing reading. Charter: principle 7 (simple, light, pleasant: a setting reads at a glance).
