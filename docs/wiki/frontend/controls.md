# Controls - one height, one edge, three components

**Why this page exists.** The owner, 2026-11-07: *"(Re)etablir certaines conventions graphiques: les
boutons ne sont pas alignes, ont des hauteurs differentes et des styles differents. Il faudrait
rendre toute l'application homogene et coherente."* The screenshot was an admin row (the
dependencies panel) holding a select with a light grey edge, a yellow filled "Enregistrer" and an
"Annuler" with a thick black edge: three controls, three heights, three styles. Nothing was wrong at
any one site; 285 files had each drawn their own. The convention below is what replaces that, and
`frontend/src/lib/styles/controlsGuard.test.ts` is what keeps it.

## The decisions (owner, 2026-11-07)

1. **One height for every control in a row: 40 px (`2.5rem`), desktop and phone.** A `compact` size
   (32 px, `2rem`) exists for a dense toolbar or grid only (a price grid, a criterion editor, a
   space list, a promo picker) - it is not the way to make a form fit, and a field `Picker` or
   `Input` in an ordinary form is never `density="compact"`: it would sit 32 px next to 40 px
   fields.
2. **The secondary button is the thin grey edge of a field, on a neutral fill.** The yellow fill is
   reserved for the primary action of a surface.
3. **Enforcement is mandatory components plus a test**, not a style guide: one Button, one text
   Field, one Select, and a test that fails CI when a screen draws one by hand.

## The tokens (`src/app.css`)

| Token | Value | Meaning |
| --- | --- | --- |
| `--control-height` | `2.5rem` | the row height |
| `--control-height-compact` | `2rem` | dense toolbars only |
| `--control-padding-x` / `-compact` | `1rem` / `0.75rem` | side padding |
| `--control-border-width` | `1px` | thin |
| `--control-border-color` | `var(--cn-border)` | the field edge, also the secondary button's |
| `--control-radius` | `var(--radius-lg)` | the existing 8px card/button step; no new corner |
| `--red-solid` | `#c42b2b` | the FILL of a danger button: white on it is 6:1 (`red-err` is a text/edge red, 3.9:1 under white and 2.8:1 in dark, under AA) |

The height is a **`min-height`**, never a fixed `height`: the Android WebView's text zoom scales
fonts and not lengths (`textZoom.ts`, `textZoomBoxes.test.ts`), so a fixed box clips a label at 200 %.
`Button` lets a label wrap (no `whitespace-nowrap`), which keeps a `w-full` French label inside a
modal at 411 px. A footer button that was taller before (the PIN modals, tight at the largest text
size on the iPhone 12) keeps its old height with a `min-h-*` utility.

An invalid field has a red halo, at rest and on focus, as well as the red edge: a 1 px red line alone
reads as decoration.

They are read by ONE class, `.ui-control` (with `--compact` and `--icon`), in the components layer
of `app.css`. It carries geometry only; colour and type belong to each component. A call-site
utility (`w-full`, `px-8`) still wins over it, but a call site should never spell a height, a
padding or a corner on a control: that is the drift this page exists to stop.

## The three components (`src/lib/components/ui/`)

- **`Button.svelte`** - variants `primary` (yellow, the surface's one action), `secondary` (grey
  edge, neutral fill: cancel, back, "Modifier"), `ghost` (no fill, no edge), `danger` (red fill);
  sizes `default` and `compact`; `icon` (a square the height of the row, needs an `aria-label`);
  `loading` (spinner, inert) and `disabled`; `href` (renders an anchor in the same box). The old
  `outline` variant (a 2 px black edge, the one in the screenshot) is gone: its three users are
  `secondary`.
- **`Input.svelte`** - THE text field (there is no separate `Field`; a parallel one would be the
  drift again). `density="compact"` for the dense case.
- **`Select.svelte`** - a labelled `Picker` (the app's own sheet/popover, never the system's
  native select on Android). `Picker variant="field"` is the same box when no label is wanted.
  `Picker`'s field density now defaults to `default` (it used to default to compact, a 38 px box
  beside a 50 px input).

`controlClasses.ts` (`controlClass()`) is the class string `Input` and `Picker` wear and the few
call sites that still draw a raw `<input>` wear until they are migrated; it now builds on
`.ui-control`, so the field edge went from 2 px to 1 px everywhere in one edit.

## The guard (`controlsGuard.test.ts`, `rawControls.ts`)

It counts `<button>`, `<select>` and text-like `<input>` (no type, a dynamic type, or text / email /
password / search / tel / url / number) in every `.svelte` file outside `src/lib/components/ui/`.
Checkboxes, radios, files, ranges, colours and the date family are never counted.

`rawControlsRatchet.json` is a **ratchet**: per file, how many of each kind it may still contain.

- A file not in the list can never gain one; a new screen uses the components or CI fails. Adding a
  file to the list is refused by the regeneration command.
- A listed file may not exceed its numbers, and may not be BELOW them without the list being
  lowered, so progress is recorded and cannot be undone silently.
- What it counts besides `<button>`: `<input type="submit|button|reset|image">`,
  `<svelte:element this="button">`, and a `<button` written inside a string of a `.ts` / `.js`
  file.
  Widening the scan re-measured the baseline once: `ChatArea.svelte` 11 to 13 (two buttons the old
  scan could not see), nothing else moved.
- **Honest limit.** Nothing in the test compares the list with `main`: a PR that edits the JSON by
  hand can raise a number or add a file and pass. Only the regeneration command refuses an
  increase, so a diff touching `rawControlsRatchet.json` is reviewed like a lockfile: every changed
  number must go DOWN.
- Lowering: `CANARI_RATCHET_WRITE=1 bun x vitest run src/lib/styles/controlsGuard.test.ts` (from
  `frontend/`). It refuses a number that went up and an entry that is new.

It runs inside `bun run test` / `make test-frontend`. No workflow was added for it.

## The inventory the day it began (2026-11-07, `main` at `1.6.7-alpha.1`)

| | Before this change | After the foundation PR |
| --- | --- | --- |
| Files with at least one raw control | 285 | 276 |
| `<button>` | 926 | 907 |
| `<select>` | 7 | 7 |
| text `<input>` | 105 | 104 |
| **All** | **1038** | **1018** |

Of the 926 buttons, by their classes (heuristic, one bucket each): 132 are `ui-icon-button` (the
44 px / 38 px square of the headers and overlays - these keep working and are migrated to
`Button icon` last, since the owner's 40 px replaces both sizes), 84 a hand-drawn yellow fill, 57 a
bordered text button, 55 padded in some other way, 27 red, 74 icon-only without that class and 497
"other" (list rows, tabs, chips, links that happen to be buttons - these need a human decision per
file, not a codemod). Before this change `Button` had 21 call sites in 14 files, four variants of
which `outline` carried a 2 px black edge.

Existing components, found before writing any: `ui/Button`, `ui/Input`, `ui/Select`, `ui/Picker`,
`ui/Textarea`, `ui/Toggle`, `ui/SegmentedControl`, `ui/DateTimeField`, `ui/CheckboxGroup`,
`ui/MenuList`, and the `.ui-icon-button` class in `app.css`. Nothing new was built in parallel.

## Migrating a file

1. A text button becomes `<Button variant="...">`: yellow fill is `primary`, red is `danger`, a
   border or a neutral fill is `secondary`, text only is `ghost`. Drop every height, padding, font
   and corner utility; keep layout (`w-full`, `shrink-0`, margins).
2. A list row, a tab or a chip is not a button in this sense: leave it, and it stays counted until a
   later change gives it a component of its own.
3. A raw text field becomes `Input` (its `class` lands on the wrapper, everything else on the
   `<input>`); a raw select becomes `Select`.
4. Lower the ratchet (command above), and look at the screen at 411 px: a row that relied on a
   smaller hand-made button may wrap now.

## What is deliberately not here

- Textareas keep their own component; they have no row height.
- The `.ui-icon-button` header chrome keeps its 44 / 38 px until its migration; touch targets are
  governed by `touchTargets.test.ts`, which this page does not replace.
- Switches and checkboxes are not controls in the sense of the three decisions.
