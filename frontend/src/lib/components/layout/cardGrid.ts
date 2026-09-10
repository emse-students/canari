/**
 * THE ONE CARD GRID, AND WHY IT COUNTS NOTHING.
 *
 * Three pages draw a wall of cards - `/associations`, `/lists`, `/shop` - and until 2026-09-10 all
 * six of their grids carried the SAME literal, `grid gap-4 sm:grid-cols-2 lg:grid-cols-3
 * xl:grid-cols-4`. Six copies of one decision is not merely duplication: it is a decision nobody
 * can change, because changing it means finding all six and being sure there were only six.
 *
 * A FIXED COLUMN COUNT IS THE WRONG SHAPE OF RULE, which is what the copies were hiding. It says
 * how many cards to draw and lets the WIDTH fall out, so the card's size depends on the page
 * column it happens to sit in - and when `grid` pages went to 1600px the four columns became
 * 388px tiles. The user reported it (*"la page /shop par exemple est super large, et les tuiles
 * sont tres larges aussi"*). `auto-fill` inverts it: the CARD's minimum is stated and the column
 * count falls out, so the same declaration gives 1 column on a phone and 6 on a 1600px page, and
 * a tile is the same size on every page at every width.
 *
 * THE 15REM COMES FROM A MEASUREMENT, not from taste. Amazon, at a 1920px window on 2026-09-10:
 * its most repeated tile width is 205px (290 elements at exactly that), then 207, 290, 192 and
 * 306, and its main product grid is five columns of 331px. So the web's own shop tile is roughly
 * 200-330px. 240px is the low end of that band plus room for the two things an Amazon tile does
 * not carry - an association's colour bar and a product's badge row. It yields 253px at 1600px,
 * 240px at 1280px, and falls to one column below 512px.
 *
 * `gap-4` is the existing gap and did not move; changing it would have re-flowed three pages for
 * no reason anyone measured.
 */
/** The stated minimum, exported so the test can assert the literal below still carries it. */
export const CARD_GRID_MIN = '15rem';

/**
 * The class every card wall uses. A string and not a component, because the grid is one
 * declaration on an element the page already owns - wrapping it would add a `div` to the tree for
 * nothing.
 *
 * SPELLED OUT AND NOT INTERPOLATED FROM `CARD_GRID_MIN`, WHICH LOOKS LIKE DUPLICATION AND IS NOT.
 * Tailwind 4 finds its utilities by scanning source text for candidates, so it would read the
 * literal characters of the interpolation placeholder rather than `15rem`, fail to parse the
 * candidate as a utility, and emit no
 * rule at all - the class would land in the DOM and mean nothing, silently, with the grid falling
 * back to one column. `pageWidth.ts` spells its arbitrary values out for the same reason.
 * `cardGrid.test.ts` asserts the two agree.
 */
export const CARD_GRID = 'grid gap-4 grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]';
