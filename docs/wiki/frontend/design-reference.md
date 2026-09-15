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
INWARD over the bubble.

**They are the STRIP's children, and that reversed a sentence this page carried for a day.** The
first attempt (2026-09-08) anchored them to the strip and laid the reaction pill 292px into the empty
gutter, so this page said "anchor them to the bubble, not to the strip" - and the diagnosis was
wrong. What put the pill in the gutter was keeping the BUBBLE's side while changing the anchor: the
strip sits on the side away from the message, so a popover hung off it has to MIRROR and grow back
inward. With the side mirrored, the strip is the right anchor and has been since 2026-09-09 - it is
what puts the pill under the smiley that opens it, which is where the user asked for it. The root is
an `absolute inset-0` box over the bubble wrapper; `right-full` puts the strip in the gutter, and the
popovers pin to the strip's inner edge.

**"Bounded by the pane" is what this page used to claim next, and NOTHING MEASURED IT** (fixed
2026-09-13). Growing inward is a direction, not a promise of room: the popover's width is fixed - six
emojis and the button that opens the full picker - and the message's is not, so a bubble NARROWER
than the popover is overshot and the pill carries on past the far edge of the scroller. `overflow-y:
auto` computes `overflow-x` to `auto` as well, so that edge clips exactly as the top one does. The
user reported it on 2026-09-13 as a reaction bar running off the window on a short message, and asked
whether it was a z-index - the same question the vertical version of this defect provoked, with the
same answer: **a z-index is the wrong question about a box that is off-screen.** Their own control
case said so, since the full emoji panel is a different component and places correctly.

The fix is the measurement the vertical axis already had, on the other axis, against the same clipper
and with the same tie-break - prefer inward, mirror only when inward does not fit and the mirror is
roomier, keep inward when neither fits. **It is measured from the STRIP and not from the bubble**,
because the popovers pin to the strip's edges; measuring the bubble is right by accident on a long
message and wrong on the short one the rule exists for, and a test drives exactly that.

### `fixed` means the viewport only while no ancestor claims it (2026-09-13)

A non-`none` `transform` - and `filter`, `backdrop-filter`, `perspective`, `contain`, and
`will-change` of any of them - makes an element the containing block for every `position: fixed`
DESCENDANT. A full-bleed overlay left in the component tree therefore does not cover the viewport;
it covers whichever ancestor happens to be transformed at that moment.

`GifPickerModal` is ONE component opened from the chat composer and from a post's comment box, and it
misbehaved in exactly one of them. `PostCard`'s card carries `hover:-translate-y-0.5`, so while the
pointer was over the card, the picker and its scrim were confined to the card's rectangle.

**Measured in a browser, 2026-09-13**, on a 400x200 stand-in card: the overlay reads `1265x400` at
`(0,0)` with no transform and `400x200` at `(109,99)` with `translateY(-2px)` - the card exactly -
and returns to the viewport the moment the transform goes.

Two things follow that a static read would miss. It is INTERMITTENT on a desktop, because the
containing block appears and disappears with the pointer, and the 300ms `transition-all` keeps the
transform non-`none` on the way out. And it is WORSE ON TOUCH, because `:hover` sticks after a tap
until something else is tapped - so on a phone the card holds the transform for as long as the
overlay is open, which is how the user reported it (*"notamment sur mobile"*).

**The fix is `use:portal`, never removing the transform.** The lift is a deliberate affordance on
every feed card; the overlay is what is in the wrong place. The repo already refused this shape for
ANCHORED panels - `fixedPopover.test.ts` fails a viewport-positioned panel left in the tree and names
this precise cause - and a `fixed inset-0` overlay is the same fact in a different spelling.

**Eleven other components declare `fixed inset-0` and stay in the tree, and they are NOT one thing**
(swept 2026-09-13, list in [backlog](../backlog.md)): five are a SCRIM behind a drawer, two are an
invisible outside-click CATCHER, and three are a modal CONTAINER. Only the third is a duplicate, and
it is a real one - `PollComposerModal`'s root class is character-for-character the picker's. The
guard shipped here is scoped to what is proven: anything the posts tree opens.

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

**AND A RUNG IS NOT A RESERVATION.** `--z-banner` says what the column paints OVER; it says nothing
about what the column DISPLACES, and until 2026-09-14 the answer was nothing at all: the column was
`fixed`, so it took no space and simply covered whatever the top of the page happened to be. What it
covered is the app header, which is `sticky top-0` and therefore lands in exactly that band -
measured on dev at 1440px the banner was 44px tall and hid the header's top 44px, the logo included;
at 390px it was 84px tall and hid the whole 56px mobile header, so a phone showed no top bar at all.
On production the environment banner never renders, but `MaintenanceAdminBanner` and
`MlsFatalErrorBanner` share the column, so the same band went missing exactly when a reader most
needed the header.

The column is now a `shrink-0` row of the shell's own flex column in `routes/+layout.svelte`, and the
sidebar-plus-content row below it is `flex-1 min-h-0`. A row cannot overlap its sibling, so this
holds at any width and for any number of banners with nothing measured and no variable to keep in
step - verified on the local estate at 390px and 1440px with zero, one and three banners up: the row
begins exactly at the column's bottom every time, the shell stays exactly one viewport tall, and the
page never gains a scrollbar. It is the same lesson `.mobile-nav-inset` in `app.css` already records
for the BottomNav at the other edge, which was `fixed` for the same reason and covered content for
the same reason.

**A page that fills the shell asks for `min-h-full`, never `min-h-dvh`.** The height to fill is the
one the shell was LEFT, which is a viewport minus the banners; a whole `dvh` inside a box that is
deliberately shorter is a second, independent statement about one height, and it wins by exactly the
banner's height. `LoginForm.svelte` carried that and would have gained a scrollbar of precisely that
size on the one screen with nothing to scroll.

**Below 60, nothing was touched.** A `z-10` ordering two children of one card competes only with its
own siblings and is invisible to everything else; naming it here would imply it can be compared with
a modal, which it cannot. The boundary is whether the element can be on screen at the same time as
something from another component.

### What keeps it a ladder

`src/lib/styles/layerLadder.test.ts`, and **two of its assertions condemn a raw number rather than
one**, because one cutoff cannot express both halves of the boundary:

- a literal `z-*` of **60 or more**, anywhere in the markup;
- a literal `z-*` of **any value at all** on an element that also carries `fixed inset-0`.

Either failure names the file, the offending token and every available rung. It also fails on a
ladder declared out of order (it caught exactly that on the first run), on two rungs sharing a value,
and on any scrim that is not strictly under the panel it dims.

**The second branch asserts an ABSENCE, so a sibling test asserts the SWEEP still sees anything at
all** - more than 500 class attributes read, more than five of them `fixed inset-0`. A regex that
stopped matching would otherwise pass for ever, silently, which is the failure mode of every gate
written as "there are none of these".

### The cutoff that a full-viewport overlay escapes, and the dialog that opened under a toast

**"Below 60, nothing was touched" is right about a `z-10` inside a card and wrong about anything
`fixed inset-0`.** The boundary above is stated correctly - *whether the element can be on screen at
the same time as something from another component* - but the gate implements it as a NUMBER, and a
full-viewport overlay is on screen with everything by construction whatever its number is.

Measured 2026-09-14, sweeping the seven hand-written modal containers: `routes/admin/agenda`'s reject
dialog carried a raw `z-50`. That is not a rung - it sits between `--z-page-overlay` (40) and
`--z-toast` (60) - so the dialog opened UNDERNEATH a toast and below every other modal on the page.
`layerLadder.test.ts` never saw it, because 50 is under the cutoff.

Nobody chose that. It is what a number picked in isolation does, and the fix is to remove the choice
rather than to police it: `ModalOverlay` takes a layer NAME (`sheet` / `modal` / `critical`) and
holds the three class literals itself. The literals have to be literals - Tailwind scans source text,
so `z-(--z-${layer})` compiles to nothing and the modal sits at `auto` - and that is exactly what
makes the CALLER able to be dynamic while the scanner stays static.

**THE GATE IS THE FIX, AND THE FIVE EDITS ARE ONLY ITS FIRST OUTPUT.** Lowering the cutoff was
never available: it would condemn every local `z-10` in the tree, which the paragraph above is right
to leave alone. The second branch condemns exactly the case the cutoff's own justification excludes,
and nothing else.

The five it found on 2026-09-14, each a different KIND - which is why none of them was already a
`ModalOverlay`, and why the fix is five different rungs rather than one:

| File | Was | Became | Why that rung |
| --- | --- | --- | --- |
| `BiometricBottomSheet` | scrim + panel, both `z-50` | `ModalOverlay layer="sheet"` | a surface a gesture opened; the hand-rolled pair is gone with it |
| `BiometricEnrollSheet` | the same shape | `ModalOverlay layer="sheet"` | the same |
| `FormBuilder` | `z-40` catcher, `z-50` dropdown | `--z-popover-scrim` / `--z-popover` | the pair designed for exactly this |
| `FormQuestionsSection` | `z-40` catcher, `z-50` picker | `--z-popover-scrim` / `--z-popover` | the same |
| `routes/admin/carte/[id]` | `z-50` full-page editor | `--z-page-overlay` (40) | a page's own surface expanded to the window, not a claim against the window |

**Both halves of a scrim/panel pair move together or the pair inverts.** The catcher is the half the
gate names - it is the one carrying `fixed inset-0` - but it exists to sit one rung UNDER the
dropdown it closes. Renaming only the catcher would have sent it from 40 to 190 and left the panel at
50: a full-screen click target over the thing it dims, which is the `Sidebar` defect this ladder was
written to end, reintroduced by the gate meant to prevent it.

**`CallOverlay` was on the suspect list and is clean** - it already takes `--z-critical` on its
`fixed inset-0` root. Its class attribute spans lines, which is why a line-oriented sweep could not
say so; the gate collapses whitespace before reading, so it can.

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

### Two more, from the graphical pass itself (2026-09-14)

Both were written down on the way through as defects to fix, and **neither survived being measured**.
They are here because the next reader of a network panel or a DevTools Issues tab will reach for the
same two conclusions, and the evidence against them is cheap to record and expensive to re-derive.

**A face with no photo does NOT cost a request per load.** The note said `GET /api/users/<id>/avatar`
404s on every page load and that the client should have learnt it from the user payload instead.
Measured on the local estate: the endpoint answers `404` with `Content-Length: 0` and
`Cache-Control: public, max-age=600`, and the browser honours it. Three `fetch`es in one document
gave `transferSize` 300, then **0**, then **0**; after a full reload, **0** again, in 1 ms, with no
network request at all. So the cost is one bodyless 404 per face per ten minutes per device, which
is the freshness policy the endpoint was deliberately given - an avatar can appear in MiGallery at
any moment, and core-service cannot know that it has without asking.

Carrying a `hasAvatar` flag on the user payload would not remove those requests; it would MOVE them,
from a lazy per-face `fetch` the client can cache to a per-user upstream call made while a list is
being assembled, and it would make the user payload fail when MiGallery does. **The discriminator
this rule asks for has to be known to the layer that would carry it, and here it is not.**

**Chromium does not warn about `apple-mobile-web-app-capable`.** The note said a deprecation warning
was logged on every load and that `mobile-web-app-capable` should be added beside it. Measured on
Chrome 153 against the served page (the tag IS in the markup): one console message on a cold load,
`Initialised in WEB mode (WASM)`, and nothing under `warn`, `error`, `verbose` or `issue`. There is
also **no web app manifest in this repository**, so the standard spelling would install nothing and
declare nothing - the Apple tag is the whole of "added to the home screen, this opens without
Safari's chrome", and it is the only one of the two any engine here reads. Adding the second name
would have put an inert tag in the source to silence a line that is not printed.

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

### The association tile: one card, five copies, and a colour that existed all along (2026-09-13)

`/associations` and `/lists` drew the same card FIVE times between them - "mes associations", every
active association, the archived fold, a campaign shelf, and the archived list fold. Every copy
`truncate`d the name and cropped the description at a raw `max-h-[2.75rem]`, which is what five
copies of a decision always means: fixing one fixes one.

**The pixel crop was measured, not merely disliked.** Against this app's own compiled CSS, that
`max-h-[2.75rem]` is 44px where the line box is 20.625px - it stopped **2.13 lines in**, leaving the
tops of the third line's letters showing. The replacement is a line CLAMP, which cuts on a line
boundary and says so with an ellipsis: 165px of description becomes 62px, exactly three line boxes.

**The clamp goes on the CONTAINER, not on the paragraph**, and that is the part worth writing down.
A `-webkit-box` clamps everything inside it as one run of lines, so a two-paragraph description is
cut once, at the third line, wherever it falls. Clamping the first paragraph instead cuts each one
separately and rendered 95px where 57 was asked for - a truncation that forgot to truncate. All
three numbers came from a browser at the real 240px column.

**AND THE TILE NOW CARRIES `Association.color`, WHICH NOTHING IN A WALL HAD EVER READ.** The field
has fed the calendar and the Carte de la Vie Asso for months, and `cardGrid.ts` sized its 15rem
minimum with *"an association's colour bar"* explicitly in the budget - a bar no tile ever drew. So
this is not a new design: it is `CardTile`, which already implements that accent (the top bar, the
hover outline gated on `(hover: hover)`, a `contrastColor`ed badge), finally being called from the
page the grid was sized for. The fallback is the one the rest of the app already spells,
`generateAvatarColor(name)`, so one association is one hue everywhere.

`CardTile`'s header row became OPTIONAL for this, and only for this: the tile puts an
`AssociationAvatar` beside the name because that falls back to INITIALS where the header frame falls
back to a generic glyph, and an association with no logo would lose the one mark that tells it
apart. Absent, never empty.

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

### 17.10 The five columns the sweep could not see, and the guard that can (2026-09-14)

17.2 measured 52 routes and was right about all 52. **Five page columns were still hand-written**,
because a width does not have to live in a route:

| Where | What it wrote | Why 17.2 missed it |
| --- | --- | --- |
| `AssociationDetailView` | `mx-auto max-w-4xl` = **896px** | a COMPONENT. `/associations/[slug]` and `/lists/[slug]` are eight-line files that render it, so the width sat one level below every file the sweep opened - and it reached TWO route families at once, exactly like the `admin/+layout.svelte` ancestor case |
| `forms/[id]` | `mx-auto max-w-2xl` = **672px** | eight pixels off the reading measure. Nothing looks wrong at 8px |
| `forms/[id]`, sticky bar | the same literal again | it is rendered OUTSIDE the column so it can stick, so the alignment is restated - and restating the value is what lets two numbers drift |
| `c/join/[token]`, `g/join/[token]` | `mx-auto max-w-md` = **448px** | two byte-identical files, and neither reads as a page |

**A COUNT OF ROUTES IS NOT A COUNT OF PAGE COLUMNS.** Same shape as the standing rule that a count
of call sites is not a count of implementations: the sweep counted the things it could enumerate,
and the defect lived in what that enumeration was a proxy FOR.

**What each became.** `AssociationDetailView` took `width="tool"` - the identical 896 the eleven
admin pages carried, becoming the identical 1024 they became - and **that single column lasted until
2026-09-14, when the mixture that justified it was read the other way**: a page that is prose on one
tab and a card wall on the next has no one right width, and a compromise fits neither half. It now
picks per ACTIVE TAB - `grid` for `calendar` (a month, `pageWidth.ts`'s own example for `grid`),
`shop` and `partnerships` (the same card walls `/shop` and `/associations` draw at `grid`), `tool`
for `about` and `members`. Capping the card walls at 1024 never shortened anything, it drew fewer
columns; and the calendar tab could not hold `/calendar`'s 360px rail until it had the width (user:
*"les pages doivent utiliser l'espace disponible. Donc si on a besoin de la largeur, on prend la
largeur"* - [calendar](modules/calendar.md)). The about text carries `PAGE_WIDTHS.reading` itself,
so widening the page never lengthens a line - which is what makes the widening free. `forms/[id]` is `width="reading"` and its sticky bar
takes the same constant rather than a second copy of the number. The join pages are
`PageContainer`s whose CARD keeps the 448 - that number was never wrong for a card, only for a page.

**The header was cutting the name off, and the measurement is brutal.** Measured at 375px against
the app's own compiled CSS: the `truncate`d `h1` had a **98px** box for content needing **573px** -
83 % of an association's name gone - because avatar and actions were both `shrink-0` in a row that
never wrapped, and `min-w-0 flex-1` handed the name what was left. With `flex-wrap`, `basis-64` and
the actions taking their own line below `sm`, the same name draws **325px over two lines with
nothing clipped**, and the card goes 122px -> 260px. That is the user's *"sur mobile, la plupart des
textes sont coupes"*: the same defect the association TILES had, in the page that exists to show
a name.

**The guard is `pageColumn.test.ts`, and it is a NUMBER rather than a list.** `mx-auto` plus a
max-width of **640px or more** is a page column, whatever the file calls it. 640 sits just under
`reading` (680) and just under the `max-w-2xl` (672) that `forms/[id]` had, so nothing can park
beside the scale; below it nothing is asserted, which is what lets the join cards keep their 448
without an exemption list. It collapses whitespace across the whole file before matching, because a
class attribute that spans lines is how the 2026-09-13 overlay sweep left two components unread.

Every value here was read off the running app, not off the Tailwind docs: `max-w-4xl` 896,
`max-w-5xl` 1024, `max-w-[42.5rem]` 680, `max-w-2xl` 672, `max-w-md` 448.

## 18. One association, one colour - the defect that was two right answers

An association picks a colour, or it does not. When it does not, the app derives one so that it is
at least STABLE. That derivation existed **thirteen times**, in two families that had been seeded
differently, and the result was visible to any member: a club with no colour of its own was drawn in
one hue on its tile in `/associations` and in a different hue on its events in `/calendar`.

| Family | Seed | Sites |
| --- | --- | --- |
| card accent | `name` | `AssociationDetailView`, `AssociationTile`, `EditBoutiqueTab`, `EditPartnershipsTab`, `routes/shop` (x2) |
| calendar accent | `id` | `feedEvents`, `MonthCalendarGridRich` (x2, the second is the co-owner line), `calendarExport` (x2, likewise), `routes/admin/agenda` |
| a third spelling | `id`, with `?.trim() \|\|` rather than `??` | `carte/generator` |

**Nothing was wrong at any single site.** Each of the thirteen expressions is obviously correct
where it stands; the duplication is not the defect, it is the reason the defect was invisible. Only
a reader holding two screens side by side could see it, and a reader holding two screens is not a
test.

**The seed is the `id`.** An id survives a rename; a name does not, so the `name` family repainted
an association on the day it changed its title - silently, and only on the six screens that used it.
The id was also already the majority (the calendar's six plus the carte, against the cards' six).

**`color?.trim() ||`, never `color ??`.** `??` only rejects `null` and `undefined`, so an
association whose colour was saved as an empty string kept `''` AS its colour and rendered
`style="background: "` - not a fallback, an absent accent. One of the thirteen already had this
right; twelve did not.

**The guard is a TREE guard, and it has to be.** `lib/associations/accent.test.ts` unit-tests
`associationAccent` and then walks `src/lib` and `src/routes` for a `generateAvatarColor` call
sitting beside a `color` fallback - the shape, not the function, because `generateAvatarColor` keeps
honest users (a member's avatar in the trombinoscope is seeded on a USER id). **A unit test of the
shared helper would have passed on every single day the two families disagreed.** It reads `.ts` as
well as `.svelte`: four of the thirteen sites were plain TypeScript, which is how the first sweep -
markup only - came back with eleven.

The count itself hid twice, and for the same reason both times: a sweep that counts FILES misses the
co-owner maps, which derive the accent a second time one line below the primary, inside the same
function. Eleven, then twelve, then thirteen.


## 19. Selecting a tab was what stopped its name fitting

> **SUPERSEDED THE SAME DAY, AND KEPT FOR WHAT IT EXPLAINS.** The bar stopped drawing text on
> 2026-09-14 (section 23), so this cell budget constrains nothing, `shortLabel` is gone from
> `AppPlace` and `bottomNavLabels.test.ts` is now `bottomNavNames.test.ts`. What survives is the
> reasoning: this is the measurement that proved a four-cell bar cannot hold a name at the type
> floor, which is half of why the labels went.

**A bottom-bar cell is a quarter of the window, and it is the narrowest measure in the app.** The
bar draws the four `mobileNav` places, so the cell is `width / 4`: 97.5px at 390, 93.8px at 375, and
**90px at 360** - one of the commonest Android widths, and narrower than the 375px this page
measures everything else against.

Measured at the `--text-2xs` floor (12px; section 3 says nothing goes below it) against the app's own
compiled CSS, 2026-09-14:

| label | 500 | 700 (active) | narrowest cell it fits |
| --- | --- | --- | --- |
| Feed | 26.3px | 26.8px | 108px |
| Discussions | 63.8px | 65.2px | 261px |
| Communautes | 78.3px | 80.1px | 321px |
| **Tableau de bord** | 89.4px | **90.2px** | **361px** |

**The active state is what pushed it over.** A selected tab goes from weight 500 to 700, and bold
text is wider - so at 390px "Tableau de bord" had 89.5px of room and wanted 90.2px. It fit until it
was chosen, and choosing it clipped it to "Tableau de bo...". **0.7px**, which is the shape of the
defect rather than its size: the same label failed by 0.2px at 360px and by 10px at 320px.

**The padding was taken from the only element short of room.** `px-1` on the anchor spent 8px of a
90px cell on side padding the 24px icon never needed, and the label is the widest thing in the cell.
It is gone; the label gets the cell.

**That is not enough, and no layout on this page could be.** Even with the whole cell, 90.2px does
not fit 90px. **One string was being asked to work at two widths that are not comparable** - the
expanded sidebar rail is `21rem` (336px), where "Tableau de bord" is the right name and reads well.
So `AppPlace` carries a second one: `shortLabel`, identical to `label` for every place whose name
already fits, and "Tableau" (44.1px) for the dashboard. Nothing else changed name.

**The guard was a CHARACTER budget, and it said so.** happy-dom lays nothing out, so
`bottomNavLabels.test.ts` converted at the rate the table above gives - 90.2px over 15 characters is
6.01px each, and the widest sample is 6.70px - and caps a short label at **12 characters**, which is
80.4px at the pessimistic rate against a 90px cell. It runs in **both locales**, because a
translation is exactly how a name nobody measured gets in. Raising the number needs a new
measurement written beside it.

**Below 360px the bar still relies on `truncate`**, and that is deliberate rather than unnoticed:
"Communautes" wants 80.1px against a 320px cell of 80. 320px is an iPhone SE (2016); this page's
reference is 375.

## 20. The truncation census - 131 clips, and the one place none may be

From the user, 2026-09-14: *"si dans une utilisation normale il y a des choses tronquees, c'est
qu'il faudrait revoir la mise en page"*. Swept the same day: **115 `truncate` and 16 `line-clamp`
across 66 components**. They are not one defect, and treating them as one would either forgive the
real one or churn sixty files. Three categories, each with its own answer.

| Category | Count | Verdict |
| --- | --- | --- |
| A page's own `<h1>` | 2 | **Never acceptable** - fixed 2026-09-14, guard added |
| A heading in a bar or card with actions beside it on one line (`<h2>`) | 4 | Correct as it stands; wrapping moves the actions |
| A list row, a preview, a filename, a poll option | ~125 | Correct; the full value is one tap away |

**THE `<h1>` RULE, AND WHY IT IS THE ONLY ONE WORTH A GUARD.** A page title names the page the
reader is already on, so there is nothing to tap through to - and the page has a whole column to
give it, so the text WRAPS: one more line, nothing clipped. The two offenders were **the same
header written twice**:

| | shape | what the name got at 390px |
| --- | --- | --- |
| `profile/[id]` | `flex flex-col gap-5 sm:flex-row` | the whole column |
| `profile` | `flex items-center gap-5` at every width | **183px** - 96px avatar, 40px of gaps, ~39px of settings link |

One had been fixed and the other never was. Nothing was wrong at either site on its own, and only a
reader holding both files could see it - the same shape as section 18's thirteen accent
derivations. `/profile` now stacks below `sm` like its sibling, and neither carries `truncate`.

`pageTitleNotClipped.test.ts` holds it, with **no allowlist**: an `<h1>` may not carry `truncate` or
`line-clamp`, anywhere under `src`. It reads the class attribute with whitespace collapsed, for the
reason `pageColumn.test.ts` does.

**WHY `<h2>` IS DELIBERATELY NOT ASSERTED.** All four remaining are a heading sharing one line with
controls: the conversation name in `ChatHeader`, the workspace name in the sidebar's sticky header,
the panel title in `ConversationSidePanel`, and a form's title in a card of the `/forms` grid. A
heading that wraps there pushes the controls down, so the bar changes height whenever the selection
changes - a worse behaviour than a clipped name, and one the reader meets on every conversation
switch rather than once. **None of the three bars exposes the full name on hover**, which was the
open half of this: a `title` is no answer on a touch screen, and the honest one is that the full
name is on the screen the header belongs to.

**THAT OPEN HALF IS CLOSED, BY MEASUREMENT RATHER THAN BY A FIX (2026-09-14).** `ChatHeader` was
opened on eight real conversations at 390px, and it is the only one of the three that clips in
practice - the sidebar's sticky header and `ConversationSidePanel`'s title did not, with real data
at phone width. The header's arithmetic is exact and leaves the name whatever the others do not
take:

| the bar's four children at 390px | width |
| --- | --- |
| back (phone only) | 32px |
| avatar | 40px |
| **the name, the only child that yields** | **118px** |
| the actions, `shrink-0` | 140px |

plus `px-3` either side and three `gap-3`s. So **a name is cut above about eleven characters, and
five of the eight clipped** - by 9 to 26px. The three actions are 44px each because that is the
touch-target floor, and the cluster can hold six once calls revive, at which point the name has
nothing left; the `md:hidden` back button is itself a 44px target inside a `w-8` box, so it already
overhangs its own gap by 12px.

**It stays as it is because the census's own rule is satisfied, and that was checked rather than
assumed**: the settings button sitting in that same bar opens a panel whose first line is the
conversation name, rendered at 248px against the 144px it wanted - **unclipped, one tap away**. A
name that has somewhere to be read in full is a list affordance, not a defect. What would make it
one is a fourth action or a name shown nowhere else, and both are now measurable.

**The bottom bar's clipped tab label is NOT in this census**, and has its own section: nothing there
was `truncate`d by choice - the label fit until the active state made it bold, so it is a width
defect rather than a clipping decision.

## 21. The comment box cut the one sentence with nothing behind it

**A placeholder is the only text in the app with nothing to tap through to.** A list row that
clips is fine because the row opens; a heading that clips is fine when the same name is on the
screen the button beside it opens (section 20). A placeholder has neither: it is replaced by what
the reader types, so a clipped one is never read in full by anybody.

The comment composer's editor is the only flexible child of its row, and everything beside it is
fixed - a 24px avatar, a 10px gap, 14px of pill padding either side, the 44px send target with its
4px margin, and the card's own padding. Measured on the local estate at five widths, 2026-09-14,
the relation is exactly linear: **the editor gets `viewport - 184px`.**

| viewport | editor | `Soyez le premier a commenter...` (215px) | `Ajouter un commentaire...` (173.6px) |
| --- | --- | --- | --- |
| 430 | 246px | fits | fits |
| 390 | 206px | **cut by 9px** | fits |
| 375 (the reference) | **191px** | **cut by 24px** | fits, by 17px |
| 360 | 176px | **cut by 39px** | fits, by 2.4px |
| 320 | 136px | cut by 79px | cut by 37.6px |

**The layout could not pay for it.** Dropping the pill's `px-3.5` to `px-3` and the row's `gap-2.5`
to `gap-2` returns 6px of the 24 the reference is short, and 44px is the floor for the send button.
One string in one locale was roughly a quarter longer than both its English counterpart (169.9px)
and the French string beside it that fits (173.6px); it is now "Soyez le premier...", 122.7px, which fits **at every width
the app can meet, 320 included**.

**THE CHARACTER BUDGET, AND WHY SECTION 19's RULE DOES NOT TRANSFER.** happy-dom lays nothing out,
so `commentPlaceholders.test.ts` converts px to characters the way `bottomNavLabels.test.ts` did
(retired with the labels; see section 19's banner).
Section 19 takes the widest per-character rate of any sample; here that is `Add a comment...` at
8.44px each - fourteen characters in which one ellipsis and one capital dominate - and applying it
forbids `Ajouter un commentaire...`, which fits with 17px to spare. **Take the rate from the
strings long enough for the cap to bind.** Among samples of twenty characters or more the widest
is 7.55px each, and 191px over 7.55 is 25.3, so the cap is **25 characters**, in both locales,
leaving the longest string that passes 2px of room.

## 22. The post card - Facebook's chrome measured on the same phone, and the 162px it gave back

**THE REFERENCE, MEASURED 2026-09-14.** `com.facebook.katana` on A1 (Mi 9T, 1080 x 2340 real px,
436 x 945 CSS px, dpr 2.477), read with `uiautomator dump` on a GROUP page rather than the home
feed, because a group is the shape Canari's association feed actually is. Real px below; divide by
2.477 for CSS px.

| part | bounds (real px) | CSS px |
| --- | --- | --- |
| post header | y305-464 | **64 high** |
| avatar | x30-129 | 40 |
| name row | x149-956 | 326 wide |
| meta row ("2 j - Groupe prive") | y393-422 | 12 high |
| overflow `...` | x976-1080, y305-408 | **42 x 42**, flush to the screen edge |
| post text (one line) | y464-519 | 22 |
| photo | y519-1957 | 581 |
| **action bar** | x30-1050, y1958-2067 | **44 high**, 412 wide |
| like / comment / send | x30-140, x140-250, x250-360 | **44 each, grouped hard LEFT** |
| reaction faces, one kind | x1000-1050 | 20, **right-aligned on that same row** |
| reaction faces, three kinds | x920-1050 | 52, same row |
| gap to the next card | y2067-2072 | 2 |

**THREE FACTS THE DUMP SETTLES, none of them guessable from memory.**

1. **There is no reaction row.** The tally is not under the bar, it is AT THE RIGHT END OF IT. One
   44px line carries every control and every count a post has.
2. **Counts live inside the button they belong to.** The like button was 110px wide on a post with
   no count and 125px on one reading "12" - the digits sit at x95-125, inside the button's own box.
3. **There is no comment composer at rest.** Nothing is drawn for a post nobody has commented on;
   the comment icon opens it.

The header carries exactly TWO controls, each ~42 CSS px, and page names truncate there too - which
is the point already made in `PostActionsMenu`: truncation is not the defect, truncating to eight
characters is.

**CANARI, THE SAME PHONE, THE SAME MINUTE.** Measured over CDP on `/posts`, first card:

| part | before | after | Facebook |
| --- | --- | --- | --- |
| header | 68 | 68 | 64 |
| action bar | 65 | **45** | 44 |
| reaction tally | 49 (own bordered row) | **0** (on the bar) | 0 |
| comment composer at rest | 90 (every card) | **0** | 0 |
| **chrome per post** | **272** | **113** | **110** |
| card height, that post | 540 | 382 | - |

**WHAT PAID FOR IT.** The bar dropped the words "J'adore" and "Commenter" - Facebook labels
neither, and the emoji a reader chose names their own reaction better than its name did; both words
survive on `aria-label` and `title`. `ReactionsDisplay` lost its bordered band and became a
`flex-nowrap` strip rendered as a snippet inside the bar, so six kinds of reaction clip rather than
growing the bar to two lines. The resting composer's `{:else}` branch went, `showComments` being the
only thing that opens it now. Both controls grew from 36-40px to a full 44px target in the process,
which the row height was already paying for.

**WHAT IS DELIBERATELY NOT COPIED: the full-bleed card.** Facebook's cards run x0-1080 with a 2px
separator; Canari's sit at x16-420 of 436, rounded, bordered. Escaping that would mean negative
margins against `PageContainer` - **the one page column**, whose whole purpose (section 12) is to
end per-page widths and paddings. The gain is 32px of text width; the cost is reintroducing exactly
what that component exists to prevent. Not a close call, and not to be re-opened without a reason
better than "Facebook does it".

**HOW THE FACEBOOK SIDE WAS TAKEN, for anyone repeating it.** `uiautomator` cannot dump a locked
screen. MSYS rewrites an absolute POSIX path handed to `adb shell` (`/sdcard/x` becomes
`C:/Program Files/Git/sdcard/x`), so the dump needs `MSYS_NO_PATHCONV=1`, and `adb pull` needs a
Windows-style destination. A first dump caught only the composer, the stories bar and one header -
the action bar was below the fold - so the feed has to be scrolled until a bar is fully on screen
before the dump is worth anything.

## 23. The two bars - Instagram measured on the same phone, and the size that became the reference

From the user, 2026-09-14: *"Je viens de t'installer instagram pour que tu puisses observer les
elements et leurs tailles aussi. Notamment la barre de navigation en bas : pas de texte, des logos
reconnaissables, un petit point pour la notification"*, and then: *"Pour la barre du haut et celle
du bas, les tailles peuvent devenir des references (des boutons ni trop gros ni trop petits)"*.

So this section is not only a comparison. **It is where the app's chrome scale is written down.**

### The reference, in three numbers

| | value | why it is that number |
| --- | --- | --- |
| **Glyph** | **24px** | Instagram draws 59 real px in both bars on A1 (dpr 2.475) = 23.8 CSS. Canari already drew 24 in the bottom bar and 18-20 in the top one; 24 is now both. |
| **Touch target** | **44px minimum** | The smallest dimension of any Instagram control: its bottom tab is 87 x 48, its top-bar controls are 36-48 wide but the full 56 tall. 44 is the floor a control may not go under. |
| **Bar height** | **56 top, 48 bottom** (+ the safe-area inset) | Measured below. Both are Instagram's to within half a pixel. |

A control smaller than 44 is not "compact", it is a control the thumb misses; a glyph larger than 24
in a 56px bar is a bar that shouts. Neither number is a preference, and neither may move without a
new dump beside it.

### What was read, and how

A1 (Mi 9T), 436 x 945 CSS px, dpr 2.475, screen 1080 x 2340 real px - so **real px / 2.475 = CSS
px**. Instagram via `uiautomator`, Canari via CDP on port 9333, on 2026-09-14, in the same minute.

**The top bar.**

| | Instagram | Canari, before | Canari, now |
| --- | --- | --- | --- |
| status inset above it | 84 real = 33.9 | 34 | 34 |
| bar | 138 real = **55.8** | **56** | 56 |
| control box | 89 x 138 / 119 x 138 = 36 x 56, 48 x 56 | **36 x 36** | **44 x 44** |
| glyph | 59 real = **23.8** | **20**, and the bell **18** | **24** |
| avatar | - (Instagram keeps none here) | **24 x 24**, the whole button | **32**, centred in a 44 box |
| unread mark | 23 x 27 real = 9 x 11, at the glyph's top-right | a 17.6px counter, same corner | unchanged |

The height was already right and every control inside it was small: four tap targets at 36, one of
them a bare 24px avatar that WAS its own button, and a bell glyph at 18 next to two at 20. Three
sizes for one row of peers.

**The bottom bar.** Instagram's five tabs carry a `content-desc` and **not one `TextView`**.

| | Instagram | Canari, before | Canari, now |
| --- | --- | --- | --- |
| bar's own box | 118 real = **47.7** | **64** | **48** |
| + safe-area inset | 59 real = 23.8 | 25 | 25 |
| tab | 216 x 118 real = 87 x 48 | 109 x 64 | 109 x 48 |
| glyph | 59 real = **23.8** | **24** | 24 |
| text under the glyph | **none** | 10px at the `text-2xs` floor | **none** |
| unread mark | **10 real = 4 CSS**, a bare dot centred under the glyph | 10px + a 2px white ring = 14 | **6px**, no ring, under the glyph |
| profile tab image | 74 real = 29.9 | n/a (Canari draws four places, not five) | n/a |

**The glyph was already right, so the 16px is the label row and nothing else** - a third of the bar,
on every screen of the app, spent on four words.

### The three things the dump settles

**A name that is not drawn is still owed.** `sr-only` keeps each tab's accessible name, so a screen
reader loses nothing; and because no 90px cell has to hold it any more, the name is the FULL one.
"Tableau de bord", not "Tableau" - which is `shortLabel`, added hours earlier for exactly that cell
(section 19) and now deleted from `AppPlace`, from all eight places and from `messages/*.json`.
`bottomNavLabels.test.ts` became `bottomNavNames.test.ts`: the old budget constrained a width
nothing occupies, the new test asserts the thing that IS now invisible - a name, non-empty, in every
locale.

**The dot's ring was load-bearing only where the dot was.** A red disc at a glyph's top-right
overlaps the glyph, so it needed a 2px white ring to stay legible - 14px of decoration for a
one-bit fact. The label row vacated the space under the glyph, which is where Instagram puts its
own, and in clear air the dot separates itself. 6px, no ring.

**The active underline had nothing left to say.** `h-1 w-8` of amber with an 8px glow, pinned to a
bottom edge now 16px closer to the glyph, repeating what the amber tint and the 2.5 stroke on the
glyph already carry. Instagram marks its active tab with the glyph alone.

### Deliberately NOT copied

**The glyphs themselves.** Instagram's bar is home / reels / messages / search / avatar; Canari's is
feed / communities / chat / dashboard, drawn with Lucide's `Newspaper`, `Users`, `MessageCircle`,
`LayoutDashboard`. Whether `Newspaper` reads as "the page you land on" the way a house glyph would
is a product question about what the app's home IS, not a sizing one, and it is not settled by a
dump. **Left open for the user.**

**The fifth tab.** Instagram's avatar tab is its profile; Canari's profile is in the top bar, where
Instagram has a create button instead. Two different places to put the same two controls, and the
measurement says nothing about which is right.

**HOW THE INSTAGRAM SIDE WAS TAKEN.** As section 22's Facebook dump - `MSYS_NO_PATHCONV=1` for both
`adb shell uiautomator dump` and the `adb pull`, a Windows-style destination. One trap beyond it:
**launching another app steals the foreground and drops the Canari webview's CDP bridge**, so the
Canari half has to be re-armed (`bun pin.mjs --device A1`) after the Instagram half is taken, never
before.

## 24. The long-press sheet covered the message it acts on, and the thread moved instead

**Measured on A1 on 2026-09-14**, in the same guided session as sections 22 and 23. Long-press a
message near the bottom of the thread and the action sheet opens over it: the bubble at `731-767`,
the sheet's reaction strip starting at `749` - **18 of the bubble's 37 px covered, its lower half,
straight through the middle of its single line of text**. The user presses a message and can no
longer read the message they pressed.

### Why the sheet is not what moves

`[data-keyboard-aware-actions]` in `app.css` anchors it to the bottom of the screen,
`bottom: max(1rem, safe-area + 1rem)` under `.mobile-convo-open`. That is right and it stays:
**the sheet's position is a claim about where a thumb is, and the thread's is a claim about
nothing.** WhatsApp and Messenger both raise the message above the sheet and dim the rest; the half
that moves is the thread.

### The three numbers, and the one that is not obvious

`sheetClearance` in `frontend/src/lib/utils/chat/sheetClearance.ts` is the whole decision, and it is
arithmetic on measurements a caller takes once at open - no clock, no animation frame, no retry.

1. **The overlap.** `bubbleBottom + 8 - sheetTop`, the 8 being the gap that keeps the bubble off the
   sheet's edge rather than flush against it. On A1: `767 + 8 - 749 = 26`.
2. **The cap.** The lift stops when the bubble's TOP reaches the scroller's. A message taller than
   the room above the sheet cannot be shown whole whatever anyone scrolls, and lifting it until its
   bottom clears pushes its FIRST line off the top - trading the half a reader can do without for
   the half they are reading.
3. **The room, which has to exist first.** The message someone long-presses at the bottom of the
   screen is usually the LAST one, so `.chat-messages-scroll` is already at its maximum and
   `scrollTop += 26` does **nothing at all** - the obvious fix is a no-op in exactly the case that
   motivates it. The deficit is borrowed as bottom padding on the scroller while the sheet is open
   and returned when it closes, which is also what puts the thread back: nothing has to remember a
   scroll position.

### Reading the sheet's top without waiting for its transition

The sheet flies in over 220 ms, so `getBoundingClientRect().top` on the frame it opens is wherever
the transform has it, not where it comes to rest - a lift measured from that is short by whatever
the transform has left to travel. Waiting for `transitionend` would put a clock back in.

`sheetRestingTop(overlayBottom, bottomInset, sheetHeight)` takes three numbers a transform cannot
touch: the portalled `inset-0` overlay's bottom edge, the sheet's computed `bottom` (an absolute
length once resolved), and its `offsetHeight` (layout). On A1: `945 - 16 - 180 = 749`, the number
the phone reported.

### Measured on a real engine, W1 at 393x945, 2026-09-15

The arithmetic is unit-tested; this is the engine agreeing with it. One sample per animation frame,
recorded from inside the page (a CDP sample always arrived after the sheet had started closing - see
the instrument note below). The thread was at its maximum, `scrollHeight - scrollTop - clientHeight`
= **0**, which is the case the borrowed room exists for.

| frame | sheet | bubble bottom | sheet top | gap | `scrollTop` | scroller `padding-bottom` |
| --- | --- | --- | --- | --- | --- | --- |
| before | closed | 865 | - | - | 3022 | (none inline) |
| open +0 | flying in | **693** | 725 | **+33** | **3194** | **236px** |
| open +157 | at rest | 693 | 702 | **+9** | 3194 | 236px |
| closing | outro | 865 | 701 -> 724 | -163 | 3022 | (none inline) |

Three things are settled by that table.

**The computed `bottom` really is a length.** `getComputedStyle(sheet).bottom` read `16px` against a
source value of `calc(max(1rem, var(--safe-area-inset-bottom, 0px) + 1rem) + var(--keyboard-layout-inset-bottom, 0px))`.
`945 - 16 - 228 = 701`, and the sheet's own rect settled at 701. The layout computation and the
engine agree to the pixel.

**And reading the rect instead would have been wrong by exactly the fly distance.** On the first
frame the sheet is open, its `getBoundingClientRect().top` is **725**; at rest it is **701**. A lift
measured from 725 would have been 24 px short - the bubble still covered, by less, which is the
worst kind of wrong because it looks like a rounding error rather than a design fault.

**The lift is entirely borrowed.** `865 + 8 - 701 = 172`, the scroller had 0 px of room, so all 172
went into the padding: 64 px of its own becomes 236. `scrollTop` 3022 -> 3194 is the same 172, and
the bubble's bottom moves 865 -> 693 - clear of a sheet whose top is 702, by 9 px. Closing returns
every one of those numbers.

**An instrument fact this cost two runs.** Emulated touch on a DESKTOP Chrome synthesises a click
after the long press, and the portalled scrim takes it, so W1 dismisses the sheet ~200 ms after
opening it. Nothing is wrong with the app - A1 holds it open, which is how it was measured there in
the first place - but a CDP sample taken after `longPressBubble` returns always lands in the outro
and reads as "the lift never happened". **Arm a recorder before the gesture when the window you are
measuring is shorter than a round trip.**

### What the tests pin

`sheetClearance.test.ts` holds the arithmetic on A1's own numbers, and
`MessageMobileActions.clearance.svelte.test.ts` holds the wiring - that the sheet finds the scroller
from the bubble it was handed, measures from layout, borrows before it scrolls, and gives the room
back. Geometry in happy-dom is all zeroes, so every box is stubbed; that is the point, since the
rule compares numbers no engine there can produce.

**One environment fact the second file cost.** Closing the sheet plays an outro on two elements, and
tearing the test down cancels whatever is still in flight. happy-dom creates `Animation.finished`
EAGERLY and rejects it on `cancel()`; Svelte's `transitions.js` cancels the animation and never
touches that promise, so in a browser nothing is ever unhandled. The rejection is the environment's,
not the app's, and `src/test/adoptTransitionAnimations.ts` adopts it rather than changing anything
the product does. A component test that plays an outro needs it; one that only plays intros does not.
