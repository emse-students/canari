# The design reference - what Messenger and Facebook actually measure, and what Canari measures today

**Why this page exists.** The brief was to copy the ergonomics of Messenger and of a Facebook group
page, and the words for the current interface were *"fait trop IA"* and *"pas assez ergonomique"*.
That is an impression, and an impression cannot be implemented. This page turns it into numbers:
every value below was READ OFF A LIVE PAGE with `getComputedStyle`, not estimated from a screenshot,
so the redesign copies a system rather than a feeling. **Re-read this page rather than re-guessing;
the probes that produced it are described in the last section so any figure can be re-taken.**

**What is off-limits.** The yellow is Canari's identity and does not move (user, 2026-09-08:
*"Interdiction de toucher a l'identite jaune de Canari evidemment"*). Neither does the typeface -
Nunito stays (*"Ne change pas la police d'ecriture, je l'aime bien"*). Everything else - sizes,
weights, spacing, radii, surfaces, the whole colour treatment - is in scope: *"TOUT peut changer,
bouger, etre redimensionne"*. The goal is not to erase Canari's identity but to make it
*"BEAUCOUP plus ergonomique"*.

---

## 1. The finding in one line

**Canari uses 36 distinct font sizes. Messenger and Facebook use five, and it is the same five on
both surfaces.**

That single ratio is the whole diagnosis. Everything below is its detail.

---

## 2. The reference type scale - measured twice, independently

Two different Facebook-built surfaces were censused separately: a Messenger 1:1 thread and a
Facebook group page. They agree, which is what makes the scale believable as a SYSTEM rather than
one page's accident.

| size | line-height | weights seen | role | MSG runs | FB runs |
| --- | --- | --- | --- | --- | --- |
| 12px | 16px | 400, 500 | timestamps, the rarest tier | 3 | 6 |
| 13px | 16px | 400, 600 | **the dominant secondary** | 84 | 144 |
| 15px | 20px | 400, 500, 600, 700 | **body, and the composer** | 46 | 52 |
| 17px | 20px | 500, 600 | section and thread headers | 2 | 5 |
| 20px | 24px | 600 | page title (Facebook) | - | 2 |
| 24px | 28px | 700 | page title (Messenger) | 1 | - |

Three properties of that table matter more than the numbers themselves:

- **Every size is an integer, and every line-height is a multiple of 4.** 12/16, 13/16, 15/20,
  17/20, 20/24, 24/28. There is not one fractional value on either surface.
- **`letter-spacing` is `normal` on all 31 measured text runs, both pages, no exceptions.**
- **Four weights exist and no more: 400, 500, 600, 700.** Nothing at 800.

The two heaviest tiers carry almost everything: 13px for secondary text and 15px for body. A chat
application is essentially those two sizes plus a header.

## 3. The reference surfaces - opaque, and the glass is only a hover state

| Messenger | role | Facebook | role |
| --- | --- | --- | --- |
| `rgb(31, 31, 31)` | app background | `rgb(36, 37, 38)` | app background |
| `rgb(46, 46, 46)` | raised panel | `rgb(37, 39, 40)` | card |
| `rgb(62, 64, 66)` | control / input | `rgb(59, 60, 62)` | control / input |
| `rgb(76, 76, 76)` | message bubble | `rgb(48, 48, 48)` | raised |

**Every structural surface is fully opaque.** The only translucency on either page is
`rgba(255, 255, 255, 0.1 / 0.12 / 0.18)`, and it is exclusively a hover or pressed overlay laid over
an opaque parent - never the surface itself. This is the measured justification for removing
Canari's glassmorphism: the reference does not use translucency to build surfaces at all, it uses it
to signal that a pointer is over something.

## 4. The reference radii

| value | count (MSG / FB) | what has it |
| --- | --- | --- |
| `50%` | 79 / 80 | **avatars, always circular** |
| `999px` | 56 / 59 | pills: chips, filter buttons, badges |
| `18px` | 8 / 9 | **the message bubble** |
| `8px` | 28 / 23 | cards, menus, buttons, popovers |
| `12px` | 4 / 6 | the larger card |
| `6px` | 10 / - | small inline controls |

And the one that carries the most ergonomic information:

```
18px 18px 4px            <- a bubble grouped with the one BELOW it
18px 18px 18px 4px       <- a bubble grouped with the one ABOVE it
18px                     <- a bubble standing alone
```

**A 4px corner is how Messenger says "same speaker, same minute".** The grouping is expressed
entirely in the corner radius, with no separator, no repeated avatar and no repeated name.

## 5. The reference geometry - the bubble and the composer

Measured on the live thread:

| property | value |
| --- | --- |
| bubble padding | `8px 12px` |
| bubble line box, one line of text | **35-36px** (15px text, 20px line-height, 8+8 padding) |
| bubble max width | ~70% of the thread column |
| composer row height | **36px** |
| composer input | 15px / 20px, transparent, no border |
| composer container radius | `20px` |
| icon-button padding | `6px 6px 6px 6px` (94 occurrences - the single most repeated padding on the page) |
| list-row horizontal padding | `8px` and `16px` |

The composer is the same height as one bubble line. That is not a coincidence; it is why the surface
stays calm when a message is sent.

The reference padding scale, in order of how often it occurs: **6, 8, 12, 16**, then 2 and 56 for
special cases. Four numbers.

---

## 6. Canari today - the same measurements, on the same day

### 6.1 Type

One screen of `/chat` shows **nine** distinct (size, weight, line-height, tracking) combinations:

```
  4x  16px    | 700 | 24px    | normal | rgb(255, 212, 93)
  4x  15.2px  | 700 | 22.8px  | normal | rgb(234, 242, 255)   <- fractional
  4x  14px    | 400 | 20px    | normal | rgb(145, 166, 194)
  1x  20px    | 700 | 28px    | 0.5px  | rgb(234, 242, 255)   <- arbitrary tracking
  1x  11px    | 500 | 13.75px | normal | rgb(145, 166, 194)   <- fractional
  1x  12px    | 700 | 16px    | normal | rgb(234, 242, 255)
  1x  12px    | 700 | 16px    | normal | rgb(255, 212, 93)
  1x  20px    | 600 | 28px    | normal | rgb(243, 248, 255)
  1x  16px    | 400 | 24px    | normal | rgb(145, 166, 194)
```

`15.2 = 16 x 0.95` and `22.8 = 24 x 0.95`, from `font-size: 0.95rem` in `app.css`. **The fractional
values are not nine independent mistakes; they are what happens when a size is written as a fraction
of the root rather than chosen from a scale.**

Across the whole frontend the count is far worse. Source census of `frontend/src`:

| where | distinct sizes | occurrences |
| --- | --- | --- |
| Tailwind named (`text-sm`, `text-xs`, ...) | 7 | 1765 |
| Tailwind arbitrary (`text-[0.65rem]`, `text-[10px]`, ...) | **29** | 258 |
| raw `font-size:` in components | 8 | 8 |
| raw `font-size:` in `app.css` | 7 | 7 |

**36 distinct sizes.** The four commonest arbitrary ones are `0.65rem` (10.4px, 59 uses), `0.7rem`
(11.2px, 41), `10px` (29) and `11px` (28): **157 occurrences of text below 12px**, in an application
whose reference never goes below 12px and uses 13px as its secondary tier. Canari's secondary text is
systematically two to three pixels smaller than the interface it is being compared to, which is a
large part of *"pas assez ergonomique"*.

`app.css` declares **zero** `line-height` rules and exactly one `letter-spacing` (`0.04em`, line 894).
Line-heights therefore come from whatever Tailwind or the browser supplies, which is where `13.75px`
comes from.

### 6.2 There is no type token, and there is no radius token

`app.css` defines colour tokens (`--text-main`, `--text-muted`, `--cn-*`) and nothing else about
type. **There is no `--text-sm`, no `--font-size-*`, no scale of any kind.** A size is chosen at each
call site, which is exactly why there are 36 of them.

**`--radius-*` does not exist either** - a search over `frontend/src` for `--radius` returns zero
hits in `.css`, `.svelte` and `.ts` alike. `CLAUDE.md`'s CODING STANDARDS section named it as part of
the single source of truth; that claim was stale and is corrected in the same change as this page.

What exists instead is 14 distinct `rounded-*` classes:

```
659 rounded-xl      306 rounded-full   266 rounded-2xl   155 rounded-lg   72 rounded
 16 rounded-t        15 rounded-3xl     12 rounded-md      3 rounded-r     3 rounded-none
  2 rounded-tl        2 rounded-sm       2 rounded-b       1 rounded-4xl
```

plus 8 distinct raw `border-radius` values in `app.css`, including `0.85rem`, `0.65rem` and
`1.75rem`. The dominant corner is `rounded-xl` = **12px**; the reference's card corner is **8px** and
its bubble is **18px**, so Canari sits between the two and uses one value where the reference uses
two that mean different things.

### 6.3 Surfaces

The same screen shows five translucent `oklab(... / 0.1 - 0.8)` layers used as STRUCTURE, not as
hover feedback - the opposite of the reference. This is the glassmorphism to remove.

### 6.4 One concrete divergence, visible without any tooling

Conversation-list avatars are **48x48 with `border-radius: 16px`** - squircles. Every avatar on both
reference surfaces is `50%`, a circle, 80 times per page. Nothing in Canari's identity depends on the
squircle.

---

## 7. The target - what the redesign adopted (SHIPPED, see section 9)

Adopted from the measurements above, with the two exclusions honoured (Nunito stays, the yellow
stays).

**Type scale** - six steps, integers, line-heights multiples of 4:

| token | size / line-height | weight | replaces |
| --- | --- | --- | --- |
| caption | 12 / 16 | 400-500 | `0.55`-`0.7rem`, `9px`, `10px`, `11px`, `text-xs` |
| secondary | 13 / 16 | 400-600 | `0.72`-`0.82rem`, part of `text-xs`/`text-sm` |
| body | 15 / 20 | 400-600 | `0.875rem`, `0.9rem`, `0.95rem`, `text-sm` |
| emphasis | 17 / 20 | 500-600 | `1rem`-`1.1rem`, `text-base`/`text-lg` |
| title | 20 / 24 | 600-700 | `1.25rem`, `text-xl` |
| display | 24 / 28 | 700 | `1.45rem`+, `text-2xl`/`text-3xl` |

**`letter-spacing: normal` everywhere**, including the `0.5px` and the `0.04em`. **Weights 400 / 500
/ 600 / 700 only.**

**Spacing**: 2, 4, 6, 8, 12, 16, 24. The reference's 6px icon-button padding is adopted; Canari's
current 10px and 32px are not in the reference and go.

**Radii**: `8px` card and control, `18px` message bubble with the `4px` grouping corner, `999px`
pill, `50%` avatar. Four values with four distinct meanings, replacing fourteen with none.

**Surfaces**: opaque. Translucency survives only as a hover/pressed overlay
(`rgba(255,255,255,0.08-0.12)` over an opaque parent), which is the only role it has in the
reference.

**Colour**: `--cn-yellow` becomes the single interactive accent, everywhere, in place of the current
mixture (user, 2026-09-08). Where the reference uses blue for a filled primary action, Canari uses
yellow with near-black text on it, because yellow at that chroma cannot carry white text at any
accessible contrast.

---

## 8. How every number here was taken

The probes live in the session scratchpad; they are described here so they can be rebuilt, rather
than referenced by a path that will not survive the session:

- **`probe.mjs <port> <url-substring>`** - connects over CDP and walks every visible element,
  counting `(font-size, weight, line-height, letter-spacing, colour)` for each element that owns a
  text node, plus painted surfaces, radii and paddings. **It is a CENSUS, not a set of selectors**,
  because Facebook's class names are generated per session and "measure the post title" is not
  something one can write down. A type scale is the set of sizes that occur often, and it falls
  straight out of counting. A census also cannot be fooled by an unrepresentative pick.
- **`bubbles.mjs <port> <url-substring>`** - finds message bubbles BY SHAPE (painted background,
  non-zero radius, a text run inside, under 70% of the thread width) and prints radius, padding,
  fill and the gap to the previous bubble.
- **`chat-probe.mjs <port> composer|hover|menu`** - drives the surface, because Messenger's
  per-message controls do not exist in the DOM until the row is hovered. A resting census cannot see
  half of the interface a redesign most needs.
- **`measure.py` / `drive.py`** - the handset half. The phone runs at an override density of 396, so
  the scale is `396/160 = 2.475` and the usable width is **436.4 dp**, which is what the WebView
  reports as CSS pixels. Phone measurements therefore transfer to `app.css` unchanged.
  `uiautomator` gives a view's BOUNDS and never its font size, which is why the type scale above was
  taken on the desktop web and not on the device.

Only counts and geometry ever left the pages. **No message text, no name and no thread identifier is
recorded here**, because the accounts are real and this repository is public.

---

## 9. What shipped, and the two traps that only a measurement caught

The token layer landed in `app.css` and the sweeps ran across `frontend/src`. The counts are in
`CHANGELOG.md`; what belongs HERE is the part a later session would otherwise re-learn.

**The lever was Tailwind's own theme, not the components.** `--text-sm` and `--radius-xl` are
Tailwind 4 variables; redefining them in `@theme` retargeted **1765 call sites with zero component
edits**. Anyone tempted to "fix the sizes" by editing components is about to create 1765 chances to
invent a 37th size. Edit the token.

**Set the line-height as an ABSOLUTE LENGTH.** Tailwind's stock theme stores it as a ratio -
`--text-sm--line-height: calc(1.25 / 0.875)` - and multiplies. That is where `13.75px` came from. A
length cannot produce a fractional line box; a ratio always can.

**`app.html` outranks `app.css`, and it is not just a pre-paint flash.** The inline
`html[data-theme='dark'] body { background: ... }` in `src/app.html` is MORE SPECIFIC than the
`html, body` rule in the stylesheet, so it does not merely paint before the CSS loads - it wins. The
background stayed `#070b12` while every token read `#1f1f1f`, and the tokens looked correct in a
probe. Keep those three literals equal to `--cn-bg` by hand.

**AND IT HAPPENED AGAIN, TO THE PARAGRAPH ABOVE, ELEVEN HOURS LATER.** The dark palette went OLED -
`--cn-bg: #000` - and the three literals stayed at `#1f1f1f`. Measured 2026-09-08:
`getComputedStyle(document.body).backgroundColor` returned `rgb(31, 31, 31)` while
`--cn-bg` returned `#000`, so **every gutter in the app was painting a token nothing used**, and the
OLED request was delivered in the tokens only. Writing "keep them equal by hand" did not keep them
equal; nothing compares the two, and nothing can while one lives in an HTML file the stylesheet
cannot see. Until something does, **a change to `--cn-bg` is not finished until `src/app.html` is
edited in the SAME commit** - the literal is the winner, not the duplicate.

It also cost a wrong diagnosis on the way. The floating drawers looked borderless because the panel
measured rgb(18,18,18) against a surround of rgb(19,19,19), which reads as a case for raising the
panel onto a new elevation token - and a `--cn-popover` was duly added and applied. It was wrong:
`black/40` over a TRUE black ground is still black, and the surround only measured 19 because the
ground was secretly `#1f1f1f` (0.6 x 31 = 18.6). Fixing the literal gave the drawer the same
18-point step every other card gets, the token was reverted off it, and the interior surfaces that
the raise had turned into dark wells went back to matching. **A contrast that seems to need a new
token is usually a background that is not what the token says.** `--cn-popover` was kept, because
the reaction pill and the message menu DO need it: they sit on the thread panel, which is itself
`--cn-surface`, so no amount of correct background makes a same-token popover visible.

### Trap one: an invalid custom property fails silently and INHERITS

`--color-bubble-out-text: var(--cn-ink)` named a variable that does not exist - the token is declared
in `@theme` as `--color-cn-ink`, so the bare name is undefined. The declaration was dropped, the text
inherited the page's near-white, and the outgoing bubble rendered white-on-yellow at roughly 1.7:1.
**Nothing errors, nothing logs, and the result still looks like a colour somebody chose.** It was
found by reading `getComputedStyle(...).color` off a real bubble, not by looking at the screen -
a lighter-yellow-on-yellow reads as a styling choice at a glance.

### Trap two: what transfers from a measurement is the STEP, not the value

The handset pairs a `#f2f4f7` incoming bubble with a WHITE thread - about 13 points of separation.
Copying `#f2f4f7` onto Canari's `#f0f2f5` thread put the two within two points of each other and the
incoming bubble disappeared completely in the light theme. The fix was `#e4e6eb`, which restores the
measured STEP against the background Canari actually has, and mirrors the dark theme's
`#1f1f1f` -> `#3a3a3a`.

**Both were caught by re-measuring the running page after the change, and neither was visible in the
gates**: `bun run check` reported 0 errors and 0 warnings on 8171 files through both defects. A green
gate is not a working system - it is not even a legible one.

### What is deliberately NOT done

- Only the chat surface was hand-rebuilt (decision, 2026-09-08). The feed, associations, forms,
  calendar and admin screens moved with the tokens and were not individually re-examined.
- `--cn-border` is a 10% hairline where the reference measures 5%. It feeds all 566 border sites and
  most have not been re-examined; an input with no fill of its own must not vanish. **Take it down as
  surfaces get their fills** - that is the direction, not a value to preserve.
- Nine `em`-relative font sizes survive the sweep on purpose: a mention chip, inline code, and a
  markdown heading scale inside a bio must track the text around them, not a global step.

## 10. The per-message hover, and the one scrollbar

### The reference, measured 2026-09-08

Messenger reveals **three circular 28x28 transparent buttons**, adjacent at a 28px pitch, OUTSIDE
the bubble on the side away from the window edge and centred on the bubble's middle. Order **from
the bubble outward is react, reply, more**. There is **no transition at all** - they are simply
there. Pressing react opens a pill measuring **288x52, radius 24px, background `rgb(31,31,31)`,
padding `8px 12px`**, holding six emojis plus a **36x36 round "+"** that opens the full picker.

### What Canari had, and why the shape was the defect

One strip carrying six emojis AND every action, fading in over 200ms ABOVE the bubble. Two
consequences, both reported by the user: hovering any message that was not the last of its group put
the strip over its neighbour, because a bar hanging off the top edge has nowhere to go in a tight
run; and eight controls arrived at once for a question that is usually "react" or "reply".

The gutter placement is not a style preference - it is the only region a thread always has spare.
The earlier fix (2026-08-15) had moved the strip ABOVE the bubble precisely to stop a 383px bar
being laid into the sidebar, where a click on a reaction switched conversation. Three 28px circles
plus a 4px offset is 88px against a gutter that is at least 30% of the pane at `md` and up, so the
overflow condition that forced that move cannot recur at this width - and the popovers extend
INWARD over the bubble, so they are bounded by the pane rather than by the bubble.

**Anchor the popovers to the bubble, not to the strip.** Positioning them against the strip put the
reaction pill 292px into the empty gutter, visually attached to nothing. The component's root is now
an `absolute inset-0` box over the bubble wrapper: `right-full` puts the strip in the gutter,
`bottom-full right-0` puts a popover above the bubble aligned to its outer edge. One positioning
context, and it is the bubble.

### One scrollbar, and the feature query that makes it work

There were **seven** definitions of the same scrollbar: `.chat-scrollbar` in `app.css` and
`.custom-scrollbar` redefined inside six components, agreeing on the shape and disagreeing on the
details (4px in three, 6px in four, two with no hover state, all webkit-only). A scroller that did
not remember to opt in got the OS bar, so three different scrollbars could be on screen at once.

All seven carried the same defect: the thumb was
`color-mix(in srgb, var(--cn-surface) 20%, transparent)`, and in light mode `--cn-surface` is
`#ffffff`. **The light-theme scrollbar was white at 20% over white - invisible**, and nothing
reported it because a missing scrollbar looks exactly like a pane that does not scroll. Measured
after the fix: thumb `rgb(214,214,214)` on white, `rgb(56,56,56)` on `#121212`.

It is now one rule on `*` in `app.css`, driven by `--scrollbar-thumb` / `--scrollbar-thumb-hover`,
which are taken from the TEXT side of the palette and flip with the theme. `.no-scrollbar` remains
the opt-out and still wins, a class selector outranking the universal one.

**The Firefox fallback needs `@supports not selector(::-webkit-scrollbar)`, and the guard is
load-bearing.** Declaring `scrollbar-width`/`scrollbar-color` unconditionally is the obvious way to
cover Firefox and it silently destroys the webkit rule: **Chrome ignores every `::-webkit-scrollbar`
pseudo-element on an element that declares `scrollbar-width`.** Measured here - the thread's bar came
back 10px and square-ended, wearing our colour with no hover state, and `bun run check` was green
throughout. Firefox is the only engine that fails that selector query, which is exactly the set that
needs the fallback.

### And it cost five pixels on every phone before anyone looked

The rule above shipped applied to every element unconditionally, and the first Android build after it
showed why that is wrong. **Styling `::-webkit-scrollbar` converts a platform's OVERLAY scrollbar
into a classic one that reserves layout width, permanently, whether or not anything is scrolling.**
Measured on the Mi 9T: `page-scroll-wrap`, the app's main scroller on a phone, went from a **0px
gutter to 5px** - five pixels off the content width of every scrolling pane in the app, plus a grey
track sitting there for a user with no pointer to aim at it.

`@media (hover: hover) and (pointer: fine)` is the guard, and it is about the INPUT DEVICE rather
than the width: a desktop window narrowed to 390px keeps the styled bar (verified), an Android
WebView at any size does not. A scrollbar is a control for a mouse; on touch the platform's own
transient bar is already the right answer.

Nothing here was catchable from the workstation. `bun run check` was green, `bun run lint` was green,
the desktop measurement was correct, and the light/dark thumb colours were correct - the defect only
exists on a device with a coarse pointer, which is the class
[device-verification](../device-verification.md) exists for.

### An instrument fact: `Page.captureScreenshot` drops CSS `:hover`

A probe read `opacity: 1`, `display: flex`, `visibility: visible` and a real rect off the hover
toolbar; the captured PNG had nothing at those coordinates, uniform `#121212`. The DOM read and the
capture disagree because the capture loses the synthetic hover state. **A hover affordance cannot be
photographed through `Input.dispatchMouseEvent` alone** - drive it into a state the component holds
in `$state` (open the popover) and photograph that, or trust the computed-style read and say so.

## 11. The notification list

### The reference, measured 2026-09-08

Row **664 x 72-74**, radius **8px**, transparent fill. The avatar is **56x56 and it is the ACTOR'S
photo**, carrying a small coloured disc (~28px) in its lower-right corner with the type glyph -
not a type icon standing in for a face. Body text **15px / 20px**, names at weight 600, and the
whole sentence in ONE colour. The timestamp is a second line at **13px**, and it is what carries the
read state: `rgb(90,167,255)` at weight 600 while unread, `rgb(176,179,184)` at weight 400 once read,
with the row's body text muting to the same grey. There is also a dot at the right edge. Rows are
banded under bold headings - new / today / earlier - and two pills above the list filter all vs
unread.

Content was deliberately not recorded: these are the user's real notifications, and every number
above is a geometry or a colour.

### What Canari had

A **40px circle carrying the type icon** and no avatar at all, so the row answered "what" and never
"who". The actor's name was painted dark and the rest muted, which reads as two pieces of
information where the reference has one. The timestamp was 12px muted in both states, and the only
unread signal was a blue dot - blue, in an app whose entire accent is the yellow. No bands, no
filter, and the list was 40px rows on the bare page ground where every other region of the shell is
a card.

The badge colours survive the move; only their size and place change. The unread accent is the brand
amber rather than the reference's blue, for the same reason the palette went neutral: the yellow is
the identity and nothing else in the app is blue.

### Two defects the rework surfaced, neither of them cosmetic

**`[].every(...)` is `true`, so an emptiness guard on a list that has not loaded yet reads as
"nothing to do".** `/notifications` fired `load(50)` and `markAllRead()` side by side without
awaiting. `markAllRead` guards on `notifications.every((n) => n.read)`; on a cold load the store is
still `[]` when that runs, the guard passes, and **the read receipt was never sent - opening the
page did not clear the badge**. The bell hid it for as long as it has existed: a dropdown only opens
after the store is populated, so that path always worked. Sequencing the two is the fix.

**A row drawn from `notif.read` cannot show what the reader came to see**, because both surfaces
mark everything read as they open. The flag is `true` for the whole list within a frame. Both now
snapshot the unread ids BEFORE the receipt goes out and style from the snapshot for the life of the
view; the server still gets the receipt, so the badge clears.

### One row, two surfaces

The page and the bell dropdown each carried their own copy of the row - icon switch, text switch,
timestamp, dot - and had already diverged: the page resolved `@[id]` mention tokens to display
names and the dropdown printed the raw token. `NotificationRow.svelte` is the single implementation,
with `compact` for the 320px dropdown.

