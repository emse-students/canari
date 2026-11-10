### Changed - one yellow accent for bars, tabs, buttons and selected states, and a darker shade of it for links and counters

The Tailwind amber scale and the `cn-yellow` utilities are replaced by four tokens (`accent`, `on-accent`, `accent-text`, `accent-icon`), measured at WCAG AA in light and dark; amber survives only as the warning colour, and a test counts what remains ([design-reference](docs/wiki/frontend/design-reference.md#one-accent-four-tokens-and-a-guard-that-counts-the-amber-scale-owner-2026-11-09)).

Review fixes: warnings keep the warning colour and an icon (toast, sign-in maintenance notice, admin database note, shop hints), warning text uses a darker `amber-warn-text` token that reaches 4.5:1 on its own tints, the selected feed label turns ink only once the pill is under it, and every solid `bg-accent` carries `text-on-accent` (guarded).
