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


## 12. The page shell - one column, one heading, no logos

**The user's brief, 2026-09-09:** *"il faudrait homogeneiser les pages du site"*, with Feed,
Communautes and Discussions named as the reference pages, and four specific complaints - Notifs is
much narrower than Feed and carries a white zone, Agenda has a link to "Associations" and a logo to
remove, Boutique has a logo to remove, Tableau de bord has a logo to remove. Then the general form:
*"toutes les pages devraient garder la meme UI (largeur du contenu principal, logo ou non, tailles
de polices pour les titres et sous-titres, emplacements), et c'est l'occasion de factoriser des
choses"*.

**Two of the three named reference pages are the same component.** `/communities` and `/chat` both
render `MainChatPage`, a full-height three-column shell with no reading column at all. So the only
reference for a *document* page was Feed, and its numbers are what the shared component now carries.

### What was measured, before any change

Every `+page.svelte` in the repo, for the container width and the `h1`:

| page | column | `h1` | logo in the heading |
| --- | --- | --- | --- |
| Feed (`/posts`) | `max-w-[42.5rem]` = **680px** | `text-2xl` + `font-brand` | no |
| Notifs | `max-w-xl` = **576px** | `text-xl` | no |
| Agenda | `max-w-3xl` = **768px** | `text-2xl` | `CalendarDays`, 28px |
| Boutique | `max-w-4xl` = **896px** | `text-2xl` | `ShoppingBag`, 28px |
| Tableau de bord | `max-w-4xl` = **896px**, `p-6` | `text-2xl` | `LayoutDashboard`, 28px |
| Annuaire, Documents, Formulaires, Parametres, Profil, admin | 3 more distinct widths | `text-xl` .. `text-3xl` | 4 more logos |

**Eight distinct content widths across 34 routes, and nothing chose any of them** - each was whatever
the page that came first happened to carry. The visible consequence is the one the user reported:
moving between two tabs of the same app moves the text under the reader.

Two findings the sweep produced that the eye could not:

- **`font-brand` on the Feed's title is a no-op.** `app.css:319` already gives `h1..h6` the Fredoka
  face, so the class made one page look deliberate and the other 33 look accidental while changing
  nothing. It is not set in the shared heading.
- **Three routes nested a `<main>` inside the shell's own `<main id="main-content">`** - a landmark
  inside itself, so a screen reader had two "main" regions to choose between. The shared container is
  a `div` for that reason, and the count is now 1 everywhere.

### What the shared components are

`PageContainer.svelte` and `PageHeader.svelte`, in `src/lib/components/layout/`.

- **The column is the Feed's**, 680px, with the Feed's rhythm (`px-4 py-6 md:px-8 md:py-8`) and its
  `animate-rise-in`. `wide` is a SECOND declared value (`max-w-5xl`) for the four surfaces that are
  editors rather than documents - the form builder, form creation, the export table and the service
  status board - where 680px cannot hold the controls. Two named widths, not eight ad-hoc ones.
- **No bottom padding for the mobile tab bar.** The shell's scroll wrapper already reserves
  `4rem + safe-area`; Notifs was adding `pb-24` on top of it and padding twice.
- **The heading is `text-2xl` bold over `text-sm` muted**, which is the majority convention the
  measurement found - 21 of 34 routes already used exactly that. The two outliers were Notifs at
  `text-xl` and the legal pages at `text-3xl`.
- **NO ICON, on any page.** A glyph beside a word that already names the page costs vertical space and
  makes three pages look like three products. The navigation carries the icons and is where the reader
  looks for them.
- **`backHref` / `backLabel`** is the one place a back link may be drawn, so its placement is the same
  on the five pages that are genuinely sub-pages. The Agenda's was DELETED rather than moved: the
  agenda is a top-level navigation destination, so following its link to `/associations` sent the
  reader somewhere they had never been.
- **`aside`** carries the Feed's `ConversationsMiniPanel`, the one column that lives outside the
  reading width.

### What it covers, and what it deliberately does not

**26 of 34 routes** are on the shared column. The eight that are not, and why:

| left alone | why |
| --- | --- |
| `legal/cgu`, `legal/privacy`, `legal/child-safety` | public legal documents, not app pages |
| `c/join/[token]`, `g/join/[token]` | invite landing cards, outside the shell |
| `forms/[id]` | the public form view, whose coloured hero IS its heading |
| `profile`, `profile/[id]` | on the shared COLUMN, but with no `PageHeader`: a profile's title is the person, drawn inside the identity card, and a name above it would say it twice |

Three raw French literals were found in the pages being converted and localized in the same pass -
`Retour aux publications`, `Publication introuvable` and `Gestion de la liste`. Nothing types a string
as user-visible, which is why they survived; the sweep is what surfaced them.

## 13. The composer row, and the rail that clipped every text it had

Two reports from the user on 2026-09-08, both measured before anything was changed, and both with a
cause that is not the one the symptom suggests.

### The composer sat 4px low, on a phone and nowhere else

Measured at 390x844 through CDP, on the live local estate:

| element | phone (390px) | desktop (>=768px) |
| --- | --- | --- |
| `.chat-composer-icon-button` | **44px** | 36px |
| `.chat-composer-send-button` | **44px** | 36px |
| `.chat-composer-textarea`, one line | 36px | 36px |
| centre-line delta, field vs icons | **4px** | 0px |

**THE DESKTOP COLUMN IS 38px SINCE 2026-09-10 AND THE BOX IS NO LONGER THIS ROW'S** - see *One box
for every icon button* below. The 44/36 split this row invented for itself is what the whole app
uses now, at 44/38; the field's desktop padding moved to `0.5625rem` in the same change so the two
still agree, measured 38 against 38.

The row is `align-items: flex-end`. That is CORRECT once the field has grown - the buttons hug the
bottom, as the reference does - and it is only wrong when the field is one line and shorter than the
controls beside it. Below 768px the controls are 44px because a touch target is 44px; the field was
36px everywhere. So the text sat exactly 4px below the icons' centre line, on a phone only, which is
why it survived every look at a desktop browser and got reported twice.

**The height comes from the PADDING, never from a floor above the natural height.** The placeholder is
`absolute inset-0` and positions its text with the same padding as the editor, so a `min-height`
taller than the content leaves the placeholder off the line the real text sits on - that was the
defect this file already records at section 9, and it is why the fix is `padding: 0.75rem` (12 + 20 +
12 = 44) on a phone and `0.5rem 0.75rem` (8 + 20 + 8 = 36) from 768px up. `--composer-field-height` is
declared in the same block as the padding that produces it, so a floor and a padding in two different
files can no longer disagree.

Measured after: **`midDelta` 4 -> 0** on the phone, 0 -> 0 on the desktop.

### The edge controls fold while you type

The user's words: *"sur messenger, les icones sur les bords disparaissent quand tu commences a taper
pour laisser toute la place"*. Three of the four already did this - poll, GIF and the voice recorder
all guarded on `isComposing` - and the paperclip did not, which reads as an oversight rather than a
rule.

It is a **fold, not a removal**: a chevron takes the group's place and brings every button back for as
long as the message lasts. Hiding a control with no way to reach it would mean clearing a half-written
message to attach a file. The request is tracked separately from "is there text", because one flag
doing both would forget it on the next keystroke.

Measured, field width while typing: **206px -> 274px** on a phone (a third more room), 1328 -> 1336 on
a desktop DM where the paperclip is the only control. In a community channel the folded group is
paperclip + poll + GIF + voice.

**One of the fix's own defects was caught by the same measurement.** The chevron is styled narrower
than the buttons it stands for, but it also carried `.chat-composer-icon-button`, and the desktop
block set `width: 2.25rem` on that class LATER in `app.css` - a single-class rule beating a
single-class rule on source order. The chevron rendered at 36px and folding freed exactly **0px**.

**IT WAS STILL 36px UNTIL 2026-09-10, and the two-class rule is not what fixed it.** The desktop
override is gone: the box comes from `.ui-icon-button`, which is in `@layer components`, and
`.chat-composer-icon-button.chat-composer-chevron` is UNLAYERED - unlayered beats layered whatever
the specificity. The chevron is 28px wide at every width now and folding frees 10px on a pointer.

### One box for every icon button, and two sizes rather than four

Measured on one screen of `/chat` at 1280px on 2026-09-09, then decided by the user (*"Poser la
reference ET tout aligner maintenant"*): 163 icon-only buttons visible at once, in FOUR sizes.

| button | before | after |
| --- | --- | --- |
| "Parametres de la discussion" (conversation header) | 40px | **38px** |
| "Joindre un fichier" (composer paperclip) | 36px | **38px** |
| "Envoyer le message" | 36px | **38px** |
| "Nouvelle discussion" (sidebar) | 32px | **38px** |
| "Repondre" / "Reagir" (message hover strip) | 28px | **28px** |

Four gaps of four pixels, side by side. Nobody chose them: each button was written against the one
neighbour its author had in mind.

`.ui-icon-button` declares the box and NOTHING else - 44px below `md`, 38px from `md` up, with
`.ui-icon-button--sm` at 28px for a control that only ever appears under a pointer inside a dense
row. **It deliberately does not declare the corner**, which #447 made a four-meaning scale, nor the
colour: one property, one owner. Re-measured after the sweep at 1280px - 38, 38, 38, 38, 28 - and
at the touch form - 44, 44, 44, 44, 28.

**104 call sites moved onto it; the exclusions are held by file and count in
`iconButtonScale.test.ts`, each with its reason.** Two shapes are out by construction rather than
by list: a button whose padding is asymmetric (`px-3 py-1.5` is a pill sized to a label) and a
button that declares no box at all (an inline affordance - the 12px pencil in a comment's meta
row, the cross in a chip, the avatar in the navbar). A third is out by name: a box measured against
a neighbour, such as a cross on a 64px thumbnail or the 48px community rail.

### The expanded rail clipped all eighteen of its texts

`w-64` is 256px. The row is `px-3` + a `w-7` icon + `gap-4`, so the text gets
256 - 24 - 28 - 16 = **188px** - and every description in the list is wider than that:

| natural width | text |
| --- | --- |
| 282px | `settings_page_subtitle` - "Preferences, securite et gestion de votre compte" |
| 219px | "Reactions, mentions et commentaires" |
| 205px | "Messages directs et petits groupes" |
| 194px | "Espaces d'associations et canaux" |
| 187px | "Vue d'ensemble de l'application" |
| 178px | "Le fil social de la communaute" |
| 131-149px | the other four |
| 34-113px | every LABEL, which always fitted |

**The 282px entry is not like the others.** The settings row borrows a PAGE subtitle - 47 characters -
where every other row uses a purpose-written `nav_*_desc` of 3 to 5 words. Fitting it would have cost
a 384px overlay, so it was given `nav_settings_desc` instead and the rail sized for the real widest,
219px, with room for the unread badge the two counted rows carry:
24 + 28 + 16 + 219 + 30 = 317px, rounded up to **`w-[21rem]` = 336px**.

Measured after: 18 texts checked at 336px, **0 clipped**.

The lesson is the one section 12 also produced: when one value in a distribution forces a layout
number, check whether it is an outlier in the CONTENT before paying for it in the LAYOUT.
## 14. Four ways to show one thing, and the one that survived

**The user's report, 2026-09-08**, naming three of them: *"Membres d'un salon de communaute ajoute un
element a cote et diminue la largeur du bloc conversation, tandis que 'Medias, liens et fichiers' fait
quelque chose par dessus, et 'Parametres du canal' ouvre un modal. Je pense qu'on pourrait tout faire,
comme sur messenger, avec un blob qui s'ajoute a cote (mais comme les autres blocs, avec les coins
arrondis etc) au lieu de par dessus. On laisse cette histoire de par dessus pour la navbar."*

### There were four, not three

Reading the code for the three named surfaces turned up a fourth with the same job:

| surface | how it drew itself | where the state lived |
| --- | --- | --- |
| Membres (channel) | inline `xl:flex` column **plus** a hand-rolled `fixed` drawer, mounted TWICE | `useConversations` |
| Medias, liens et fichiers | portalled `fixed inset-0` + scrim, on **every** viewport | a local inside `ChatArea` |
| Parametres du canal | `<Modal maxWidth="max-w-4xl">` with its own 16rem tab rail | `useConversations` |
| **Parametres de la discussion** (group/DM) | portalled `fixed inset-0` + scrim + `role="dialog"` | a local inside `ChatHeader` |

The last two are reached from **the same gear icon**: `ChatHeader` called `onOpenSettings` when the
parent supplied one (channels) and otherwise fell back to its own `showPanel`. That fallback WAS the
divergence - one button, two mechanisms, decided by a prop being absent.

Three consequences, all of them things nothing forbade rather than things anyone chose:

- **Two panels could be open at once.** The media sheet's state was a `ChatArea` local and the members
  column's was in the store, so neither could see the other. Opening media over an open members column
  drew a scrim across a column that was still there underneath.
- **The media panel covered the conversation it was describing**, on a 1920px desktop with room for a
  third column, because a child component cannot become its parent's sibling. Where the panel lived in
  the tree decided what it could look like.
- **Escape closed exactly one of the four** - the group panel, through a `svelte:window` handler inside
  `ChatHeader` keyed on that component's own flag.

### What replaced them

`ConversationSidePanel.svelte`, plus a single `sidePanel: 'members' | 'media' | 'settings' |
'conversation' | null` in `useConversations`. **One value cannot hold two panels open**, so the
illegal state stopped being reachable rather than being guarded against.

- **One instance, not two.** A desktop card and a mobile drawer as separate `{#if}` branches would
  mount `children` twice - two copies of the media panel, two decrypt passes, two of every request its
  content makes. The chrome is the only thing that differs, so the media query moves the chrome:
  `.conversation-side-panel` is `position: fixed` at the base and `position: static` from 1280px up.
- **The three CSS blocks are contiguous and ascending**, and that ordering is the mechanism. Written
  apart they were wrong: the 1280px rule sat *before* the 768px one, so at 1400px the drawer's own
  top-bar offset won on source order and pushed the column down by a whole bar.
- **Escape, the scrim, the header and the close button are declared once**, in the shell.
- **The back gesture is one entry.** `openSidePanel` unwinds the previous panel's history entry before
  pushing its own - stacking them would make one visible panel need two back presses, the second of
  which closes something that was never on screen.

Measured after, at 1920px on the live estate: opening Medias takes the thread from **1480px to 1142px**
and puts a **320px** panel beside it at `position: static`, on the same 18px gutter as the other cards.
Nothing overlays.

### What it cost, said plainly

The channel settings lost their wide two-column form. It was `max-w-4xl` with a 16rem tab rail; a
352px panel can never satisfy that, so the phone layout the file already had - a horizontal tab
scroller over one column - became the only one. Keeping the wide form behind a media query would have
left markup that nothing can ever render.

### The bottom sheet that rides the keyboard

Same session, same class of finding. `Modal` aligns `items-end sm:items-center`, so **every** modal is
a bottom sheet on a phone - pinned to the bottom edge, which means opening the keyboard shoves the
whole panel up the screen and closing it drops it back (*"le fait que ce soit colle en bas n'est pas
pratique (deplacement lors de l'ouverture et la fermeture du clavier par exemple)"*).

`topAnchored` anchors it to the top instead, and the three creation modals - new chat, new channel,
new community, each of which opens with a text field - now pass it. It is a flag and not a change of
default because a sheet is still right for a short modal with no input. `fullViewport` was NOT the
lever: it also blows the panel up to `90rem` on desktop, which a contact picker must not be.

Measured on a Mi 9T, 2026-09-09, keyboard opening and closing on the new-chat modal:

| | layout viewport | panel top | panel height |
| --- | --- | --- | --- |
| keyboard closed | 945px | **34px** | 870px |
| keyboard open | 588px | **34px** | 541px |

The top is invariant, which is the whole claim: the panel re-fits the shorter viewport instead of
being translated by it.

### What sizes a modal panel, and the two utilities that never did

`topAnchored` sets a RADIUS and nothing else, and that is the corrected version - it shipped with a
height and a max-height too, and both were inert or harmful. The rules that actually decide a panel's
box, in the order they win:

| Property | Owner | Value |
| --- | --- | --- |
| max-height | `.keyboard-aware-modal-panel` (`app.css`) | `min(92dvh, var(--app-viewport-height))` **`!important`**, no media query, every panel |
| height on a phone | `[data-keyboard-aware-overlay]` being `items-stretch` | the padded box, for any panel with no explicit height |
| the four insets | `[data-keyboard-aware-overlay]` (`app.css`) | `max(1rem, env(safe-area-inset-*))` on all four sides |

Three consequences a reader gets wrong by reading the component alone. **No `max-h-*` utility in
`Modal.svelte` has any effect** - the `!important` cap outranks all of them, so `fullViewport`'s
stated intent of `96dvh` is not what renders either; the panel measured 540.85px against a `100dvh`
of 587.88px. **A `h-[100dvh]` is redundant under `items-stretch`** and costs 3px of overflow past the
backdrop's own bottom padding. **And `rounded-none` is wrong for every one of these panels**, because
the backdrop's 1rem inset means none of them ever reaches a screen edge - square corners just draw a
slab in a moat.

The same four insets were ALSO set inline by the component, from an exported constant whose last
`max(` was never closed. It rendered anyway - CSS closes a function block left open at the end of a
value rather than dropping the declaration - which is a parser's error recovery standing in for the
value being right. The stylesheet rule is sufficient on its own, proven by the three other
`data-keyboard-aware-overlay` elements that never carried the inline copy, so the constant is deleted
rather than repaired.

## 15. The layer ladder - twenty rungs, and the two inversions that paid for it

**Counted 2026-09-09, before any of this: nineteen distinct z-index values and no scale.** `0, 1, 5,
10, 20, 22, 25, 30, 35, 40, 42, 50, 60, 110, 120, 130, 190, 200, 255, 260, 280, 300, 9999`. Every
one of them was chosen locally, by someone looking at the single neighbour they happened to think
of, which is the only way this number gets to nineteen. The user's report was the general case:
*"Regler problemes de Z-index (les panneaux peuvent se retrouver en dessous d'une partie de
l'interface, comme les bandeaux)"*.

**Two inversions were already in the tree**, neither of them visible by reading the file it lived
in:

| what | was | should have been | consequence |
| --- | --- | --- | --- |
| `MessageMobileActions` vs the banner column | `110` vs `120` | above | a full-screen scrim with a banner painted through it |
| `Sidebar`'s drawer scrim vs its drawer | `42` vs `40` | below | the scrim is a full-screen `<button>`, so the drawer stops answering |

The second was not reproduced live - `drawerMode` did not render on any route reachable from the
test estate - and it is fixed anyway, because the ladder makes it unspellable.

### The rungs

Declared in `app.css` in **ascending order**, so that reading the block is reading the stack. Markup
says `z-(--z-modal)`; twenty-six call sites were converted.

| rung | value | what it is |
| --- | --- | --- |
| `--z-nav-scrim` | 22 | the scrim under the expanded nav rail |
| `--z-nav-rail` | 30 | the expanded nav rail |
| `--z-page-sticky` | 35 | a sticky date pill inside a scroller |
| `--z-page-overlay` | 40 | the chat's own banner stack, the composer footer |
| `--z-nav-drawer-scrim` | 42 | |
| `--z-nav-drawer` | 44 | |
| `--z-toast` | 60 | |
| `--z-banner` | 120 | the window-scale banner column in the root layout |
| `--z-sheet` | 160 | a surface a GESTURE opened: message actions, GIF and poll pickers |
| `--z-popover-scrim` | 190 | |
| `--z-popover` | 200 | anchored to a control: notification panel, emoji picker |
| `--z-side-panel-scrim` | 255 | |
| `--z-side-panel` | 260 | |
| `--z-modal` | 280 | |
| `--z-modal-popover` | 290 | a dropdown opened from inside a modal, portalled out of it |
| `--z-viewer` | 300 | a full-screen media viewer |
| `--z-critical` | 320 | a confirmation, the call UI |
| `--z-call-notice` | 340 | the incoming-call notice, which must clear even the call UI |
| `--z-tooltip` | 400 | follows the pointer, never interactive |
| `--z-skip-link` | 500 | the way out for someone who cannot use a pointer |

**A sheet sits above the banner deliberately.** A banner is ambient; a sheet is what the reader just
asked for.

**Below 60, nothing was touched.** A `z-10` ordering two children of one card competes only with its
own siblings and is invisible to everything else; naming it here would imply it can be compared with
a modal, which it cannot. The boundary is whether the element can be on screen at the same time as
something from another component.

### What keeps it a ladder

`src/lib/styles/layerLadder.test.ts`, five assertions, and the fifth is the one that matters: it
fails on a literal `z-*` of 60 or more anywhere in the markup and the failure names the file, the
offending token and every available rung. It also fails on a ladder declared out of order (it caught
exactly that on the first run), on two rungs sharing a value, and on any scrim that is not strictly
under the panel it dims.

### The thing a ladder cannot fix

**A rung is only comparable inside its own stacking context, and `will-change: transform` makes one
silently - plus a containing block for `position: fixed`.**

`.page-scroll-wrap` carries it for the swipe-between-tabs gesture. Measured on `/chat` at 393px, the
ancestor chain of the message-actions sheet was:

```
.page-scroll-wrap        will-change: transform   -> stacking context + fixed containing block
div.relative.z-10        z-index 10               -> the whole page sits at rung 10
```

So `inset-0` resolved against the WRAPPER's box rather than the viewport, and the sheet's rung was
compared only with the wrapper's own children: a sheet asking for 160 was really asking for
160-of-10, and anything the wrapper does not cover stayed outside the scrim. On the web at 393px the
wrapper happens to fill the screen, which is why the sheet looked right there and was reported wrong
on the phone.

**Anything that must escape a page entirely has to be portalled to the body.**
`MessageMobileActions` now is; `UserAutocomplete` already was. `transform`, `filter`,
`opacity < 1`, `contain: paint` and `isolation: isolate` are the same trap.

## 16. Three questions measured and settled, so nobody counts them again

Each of these closed a backlog entry on 2026-09-09. They live here rather than there because a
closed entry has to LEAVE the backlog - the story goes to `CHANGELOG.md`, the rule to
[durable-rules](../durable-rules.md), and the measurement to the page it is about, which is this
one.

**The emoji picker scrolls, and it stays on screen, INCLUDING at the edges.** Measured on the live
app: the shadow root's `.tabpanel` reads `clientHeight=263` against `scrollHeight=880` and
`scrollTop = 400` takes; the panel is `350x400 at 332,177`, fully inside. Forced to a `1000x420`
viewport and opened from the FIRST and the LAST bubble in a thread, it lands `352x282 at 420,130`
and `352x340 at 344,8` - both entirely inside, both scrolling. The inline `height:` that the old
report blamed was already gone, and deleting it was NOT sufficient on its own: with `flex-1` kept,
the section still measured 973px inside 417. `min-h-0 w-full flex-auto` is what sizes correctly, and
the reason is in the component's own comment.

**`MIN_USEFUL_HEIGHT` exceeding the room on the chosen side is not a fault.** A panel smaller than
it shows a header and a clipped first row, so the height is KEPT and the panel is moved instead.
What it may never exceed is the viewport, and that IS enforced. Both are pinned in
`fixedPopover.test.ts`.

**Two things were looked for and NOT found, while sweeping the corners.** The 73 raw hex values in
markup are overwhelmingly legitimate - canvas drawing in `AssociationLogoCropper` and
`PosterCanvas`, and the swatch DATA in `ColorPicker` and `EditProfileTab`, where a literal colour is
the content and not a token violation. The nine `text-[Nem]` values are proportional sizing, a
different intent from the seven `--text-*` steps. Neither is a finding, and counting them as one
would have made the sweep wrong in the other direction.

## 17. The width sweep - three references, 52 routes, and the three pages that invented a number

Section 12 gave the app one page column and two named widths. This section is what happened when
every route was actually MEASURED against it, and against the web, on 2026-09-10. The user's
report: *"Il y a des disparites importantes de largeur, et c'est tres bizarre. C'est tres bizarre
quand c'est trop large, trop etroit, ou quand ca change tout le temps."*

### 17.1 The three web references, measured the same day at a 1920px window

Geometry only. Facebook and Messenger are read for element boxes and computed colours, never for
content, and no capture is kept.

| Reference | What was measured | Value |
| --- | --- | --- |
| Facebook, feed | the post column | **680px exactly** - 153 elements at that width, three articles each `left 613, width 680` |
| Google Agenda, month | `[role=main]` | **1592px** (`left 256, right 1848`) - effectively full-bleed |
| Amazon, catalogue | `.a-container` | **1905px**, full-bleed |
| Amazon, tiles | the most repeated tile width | **205px** (290 elements), then 207, 290, 192, 306; the main product grid is 5 columns of **331px** |

**Canari's own doctrine survived the comparison unchanged.** `reading: 680` is Facebook's feed
width to the pixel, and `grid: 1600` is within half a percent of Google Agenda's 1592. Nothing in
`pageWidth.ts` moved as a result of this sweep - which is the useful outcome, because it means the
disparities were pages NOT USING it rather than the values being wrong.

### 17.2 What the sweep found

**27 of 52 routes do not use `PageContainer` at all**, and most of them are right not to:
`/communities` renders `MainChatPage`, the full-height three-column shell, exactly like `/chat`.
Two GROUPS, though, had invented a width, and both did it in a place that reached many pages at
once:

| Group | Was | Now | Why it mattered |
| --- | --- | --- | --- |
| `/admin/*`, 11 pages | `mx-auto max-w-4xl` = **896px** in `admin/+layout.svelte` | `PageContainer width="tool"` = **1024px** | A FOURTH width, and being an ANCESTOR it CLAMPED the pages below it - `/admin/status` declared `width="tool"` and was drawn at 896 with nothing reporting the difference. Measured at 1440px: eleven pages, eleven times 896. |
| `/legal/*`, 3 pages | `mx-auto max-w-2xl` = **672px** | `PageContainer width="reading"` = **680px** | A FIFTH width, on the same element as the heading, so it capped the chrome too. |

**A fourth width applied by an ancestor is worse than one applied by a page**, because the page
still declares the right thing and every instrument agrees with it. The only way to see it is to
measure the rendered box, which is why this sweep exists.

### 17.3 The card wall - the rule had the wrong shape, and six copies hid it

Six grids across `/associations` (3), `/lists` (2) and `/shop` (1) carried the identical literal
`grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4`. Six copies of one decision is a decision
nobody can change; but the deeper fault is that **a fixed column count states the wrong thing**. It
says how many cards to draw and lets the WIDTH fall out, so a card's size depends on whichever page
column it happens to sit in - and once `grid` pages went to 1600px, four columns meant **388px
tiles**, roughly double Amazon's dominant 205.

`frontend/src/lib/components/layout/cardGrid.ts` inverts it: the CARD's minimum is stated at
`15rem` and the column count follows.

| Window | Was (4 cols at the cap) | Now |
| --- | --- | --- |
| 1280px | 4 x ~267px | 4 x **267px** |
| 1440px | 4 x ~308px | 5 x **242px** |
| 1920px | 4 x **388px** | 6 x **253px** |

All three pages measure identically, which is the property that was missing. `cardGrid.test.ts`
asserts every card wall uses the constant - **by naming `CardTile` rather than by matching classes**,
and §17.7 is the story of why the first version of that guard, which matched the ladder
`sm:grid-cols-2 lg:grid-cols-3`, missed four walls including the one the user reported next.

`auto-fill` and not `auto-fit`: `auto-fit` collapses the empty tracks and stretches the survivors,
so a section holding one association would draw a single card 1600px wide. Every one of these
grids can hold one item.

### 17.4 Two defects the narrower tile surfaced, and they are the same defect

A number input inside a shop tile could not shrink below its intrinsic ~170px, so the currency
label beside it was cut off by the card's edge at 242px. The cause is that **a flex item's
`min-width` is `auto`, which resolves to min-content** - the exact rule that made a grid `1fr`
track overflow `/calendar/export` in the same sweep, since `1fr` is `minmax(auto, 1fr)`. One rule,
two symptoms, two call sites: `min-w-0` on the flex item, `minmax(0, 1fr)` on the grid track.

**A layout bug that only appears at a narrower size was always there.** Neither of these was
introduced by the width work; both were held out of sight by a container wide enough to hide them.

### 17.5 The legal documents

Sharing the shell (`lib/components/legal/LegalDocument.svelte`) is the smaller half. The design was
*"vraiment pauvre"*, and the three causes are each a rule:

1. **The body was set as caption text** - `text-text-muted text-sm` on nearly every paragraph of a
   legally binding document. A muted colour means "subordinate to something", and there was nothing
   for it to be subordinate to. The one place it IS right is a note ABOUT a clause, which is what
   `.legal-fineprint` is for.
2. **Everything was a card.** Twenty-odd `rounded-xl border bg-white/10` blocks meant the two that
   are genuine warnings - the encryption note, the CSAE prohibition - read exactly like a list of
   defined terms. Cards are now spent on callouts only; a definition list is a `<dl>` with a
   hanging rule.
3. **It wore the login screen's glass.** `bg-white/20`, `border-white/40`, `shadow-2xl` and a
   centred favicon work over the auth screen's backdrop and float over nothing on a document route.

The type is set once, on the elements, in the shell's own `:global()` block: three documents
totalling ~900 lines cannot hold one measure if every paragraph restates it, and they did not. The
table of contents uses an `IntersectionObserver` rather than `:target`, because `:target` only
changes when the reader CLICKS - scrolling would leave it pointing at whatever was clicked last.

### 17.6 An instrument fact this sweep cost an hour to

**The local estate's frontend image is `frontend/build`, and that directory means two different
things.** A bare `bun run build` produces the adapter-static SPA; the SSR container needs
`BUILD_WEB=1 bun run build`, which produces adapter-node with an `index.js` at the root. Building
without it and baking the image leaves the container crash-looping on
`Cannot find module '/app/index.js'` while nginx still serves the PREVIOUS assets - so the site
answers, the pages render, and every measurement is of the old build. Rebuild both `frontend-ssr`
and `nginx`, and always through the Makefile's env file: `docker compose` without
`--env-file infrastructure/.env` starts garage with a blank RPC secret and takes half the estate
down with it.

### 17.7 The seventh wall, and a guard narrowed to the shape of the defect it already knew

The sweep of 17.3 shipped, and the user came back the same evening with a screenshot: *"Les tiles
de /shop m'ont l'air tres large toujours."* They were. Two partnership tiles, **660px each at a
1384px window**, against the 205px Amazon tile the sweep had measured against.

**The wall was real and the guard reported the tree clean.** `PartnershipCardList.svelte` carried
`grid gap-4 sm:grid-cols-2`, and it escaped `cardGrid.test.ts` twice over, for two independent
reasons - either one alone would have been enough:

1. **The walk covered `src/routes` only.** This wall lives in `src/lib/components/shop/`, where the
   scan never went. Three more were found there once looked for.
2. **The pattern demanded the full ladder** `sm:grid-cols-2 lg:grid-cols-3`. This wall stops
   climbing at two columns, so it never matched.

The second reason is the instructive one, because it was **deliberate**. A first draft had matched
any `sm:grid-cols-2` and caught `/calendar`'s start/end datetime pair - a form row, correctly a
fixed count, because two inputs do not re-flow into three. The response was to narrow the pattern
to the ladder the six known copies happened to share. **That reasoned about the false positive and
threw away the true positive hiding behind it**: the guard was left describing the copies it was
written against rather than the rule it was meant to hold.

**So the rewrite names the thing instead of the styling.** `CardTile` IS the card, and a grid that
renders one is a card wall by construction - a fact no re-typing of classes can disguise. Measured
against the population before being believed, per the standing rule: a draft matching any grid
above an `{#each}` accused **21** places - a PIN keypad at 3 columns, a month at 7, a colour
palette at 5, a photo mosaic at 2 - every one a fixed count that IS the design and must never
re-flow. **None of them renders a `CardTile`, and that is the entire difference.**

Four walls were repaired: `PartnershipCardList`, `AssociationDetailView`'s products, and the
`EditBoutiqueTab` / `EditPartnershipsTab` edit grids. Measured on the compiled stylesheet:

| Window | Was (`sm:grid-cols-2`) | Now (`CARD_GRID`) |
| --- | --- | --- |
| 1384px (the user's) | 2 x **660px** | 5 x **254px** |
| 1600px | 2 x 768px | 6 x 245px |
| 1920px | 2 x 792px | 6 x **253px** |

The 253px at 1920 is the same figure 17.3 records for the other three pages, which is the property
that was missing. **`auto-fill` earns its keep here specifically**: the screenshot showed a section
holding exactly TWO cards, and `auto-fit` would have collapsed the empty tracks and stretched those
two back to 660px each - the defect restored by the fix.

**Two things the rewrite is careful about.** The guard now carries a second assertion that it
FINDS the walls it checks, and that assertion failed on its own first run: the pattern was
case-sensitive, every repaired wall spells `{CARD_GRID}` in upper case, so it matched zero grids
and the offender check passed vacuously - the exact failure of its predecessor, reproduced within
minutes. And its floor is **five, measured**, not the seven a first draft guessed from the "six
copies" story: six files render `CardTile`, five in a wall, and `CardIconEditor` draws one tile as
a preview of an icon being chosen, which is correctly not a grid at all.

### 17.8 `/calendar` - the page the sweep never touched, and the shape it was missing

**`/calendar` was not in 17.2's table**, and that was not an oversight in the measurement so much
as a limit of what the measurement asked. The sweep compared page WIDTHS against three references
and moved the two groups that disagreed; `/calendar` was already `grid` (1600px), which is the
right width for a month. It was the ARRANGEMENT inside that width that was wrong, and a width
audit cannot see an arrangement.

The user named it exactly (2026-09-10): *"On pourrait reprendre exactement les formes de
/calendar/export pour /calendar (pour la version web du moins), avec le calendrier a droite et le
panneau a gauche."*

**What was there.** Everything stacked: a full-width control bar (month navigation, association
filter, export and subscribe), then the month grid, then the events of the selected day BELOW the
grid. Two consequences, both measured at a 1440px window:

- the month had the whole column, so seven columns came out at **182px each**, and
- the day you clicked rendered under a 700px-tall grid, which on that window is below the fold.

**What it is now** - `lg:grid-cols-[360px_minmax(0,1fr)]`, the identical declaration
`/calendar/export` uses, with the rail `lg:sticky lg:top-4`:

| | Was | Now |
| --- | --- | --- |
| left rail | none | **360px**, sticky, holding nav + filter + actions + the selected day |
| month grid | 1272px | **896px** |
| day cell | 182px | **128px** |

**This is also Google Agenda's shape**, which matters because Google Agenda is one of the three
references this page was measured against in the first place. Its `[role=main]` measured 1592px at
a 1920px window with its left edge at 256 - that 256 is a fixed rail, and the month takes the rest.
17.1 recorded the width and not the arrangement, so the sweep copied the number and missed the
form.

**The rail is 360 and not 256 because the user asked for the export page's shape exactly**, and
that page states 360. The cost is visible and worth stating: at a 1920px window the day cell comes
out at **173px**, inside Google's own band, but at 1440px it is 128px, which is narrower than
Google would give (~169px). Narrowing the rail toward 300px is the lever if that reads too tight;
nothing else needs to move.

**One defect fell out of the narrower cell, and it was always there.** On a day whose first event
carries a long title, the centred title ran straight over the absolutely-positioned day number in
the corner - "29" rendered as "2". At 182px cells `px-3` left enough slack that the two never met.
**This is 17.4's lesson a second time: a layout bug that only appears at a narrower size was
already there**, held out of sight by a container wide enough to hide it. What it took to actually
close it is 17.9.

### 17.9 The month grew, took the sheet's title, and the day number stopped being overrun twice

**The ask, verbatim** (user, 2026-09-10): *"Tu peux afficher plus grand (en hauteur) le calendrier,
et mettre le titre 'Septembre'... En fait tout comme l'export PDF, qui est tres bien, bien
lisible."* So the reference for this section is not Google or Facebook - it is `/calendar/export`,
which is the version of this same calendar the user already finds comfortable.

**The sheet's geometry, from `lib/utils/calendarExport.ts`**, which is an HTML-string generator for
a fixed 1080x764 A4-landscape page rather than a component: `HEADER_H = 88`, `WEEKDAY_ROW_H = 40`,
`CELL_H = floor((764 - 88 - 40 - 20) / nRows)` = **123px for a 5-row month against a 154px cell
width**, the month title 30px Fredoka centred in the header, and the first event slot a flex
column - **day number in its own 20px row, title centred below it**.

| | Was | Now | The sheet |
| --- | --- | --- | --- |
| month title | none on the grid | **"Septembre"**, 28px Fredoka | 30px Fredoka |
| day cell | 127 x **100** | 127 x **128** | 154 x 123 |
| whole card | 620px tall | **748px** | 764px |

Measured at the user's 1440x950 window, September 2026 (5 rows).

**Three things were copied and one was deliberately not.** Copied: the title band, the cell height,
and the first slot's flex column. Not copied: the sheet's 9px font floor. `app.css` states that
`--text-2xs` is 12px and that "nothing goes below this", 9px being "the single largest contributor
to *pas assez ergonomique*". So `fitEventText` gained a `minFontSize` parameter defaulting to 9 -
the sheet's behaviour byte-for-byte - and the screen passes 12. At that floor the ladder can only
land on 12 or 13, which are exactly `--text-2xs` and `--text-xs`: **the screen never leaves the
scale**, and the component emits the token rather than the number so it cannot drift off it.

**The "29" defect took two fixes, and the first one is the interesting failure.** 17.8 reserved
`px-5` on the first slot. That treats the symptom as horizontal, and it is not. A day with THREE
events splits a 128px cell into 42px slots; the number takes 20; a title clamped to two lines wants
`2 x 12 x 1.25 = 30px` in the 22px that remain, so the centred span overflowed its row in both
directions and painted over the number again - visibly, on the 29th, in the screenshot taken to
confirm the first fix. **`line-clamp-2` was a guess about how much room a slot has.** The fix is
not a bigger inset but the sheet's own two answers: a row the title cannot enter, and a clamp
computed from the height rather than written down. `fitEventText` is now exported and called by
both, so the screen and the sheet cannot disagree about what fits.

**One number, one statement.** The cell height is an inline `min-height:{CELL_H}px`, not a
`min-h-32` utility, because the slot arithmetic needs the same figure: a class and a constant would
be two statements of one fact, and a drift between them shows up only as titles that no longer fit
boxes they were sized for. There is also no breakpoint on it - `MonthCalendarGridRich` renders only
above `SCHEDULE_AGENDA_QUERY` (767.98px), so the `sm:` variant the cells used to carry could never
not apply.

**What guards it**: four tests on `fitEventText` in `calendarExport.test.ts` - the sheet still gets
its 9px floor, the screen never goes below 12, the day-29 case resolves to one line, and across
every height from 4 to 200px at both floors the clamp never asks for more height than it has.

**The controls became snippets, and not to save typing.** They have two homes now - the phone's
bar and the desktop's rail - and the phone's branch is byte-for-byte what it was. Copying them
would be two month navigations able to disagree about what `prevMonth` resets, in a component
that already sets `selectedDay = null` from three places.
