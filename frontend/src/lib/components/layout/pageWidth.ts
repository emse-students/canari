/**
 * THE THREE SHAPES A PAGE CAN BE, AND THE ONLY WIDTHS ANY OF THEM MAY HAVE.
 *
 * The split used to be document-versus-editor: one reading width, plus a `wide` escape hatch for
 * "the few surfaces that are editors rather than documents". That taxonomy left every GRID page
 * measured by a rule written for prose, and the user reported the result on 2026-09-09: *"les
 * pages web n'exploitent pas du tout la largeur de l'ecran... tout est serre au milieu"*.
 *
 * Measured that day, off the pages' own grid classes: 22 of the 26 routes using the page column sat
 * at 680px, and the four that did not were all forms or tables. `/associations` and `/lists` drew
 * two club cards to a row at ~330px each, `/shop` two products, and a whole MONTH fitted in 680px
 * at ~95px a day. On a 1920px window the page used 35% of the width.
 *
 * **The first pass of that survey also mis-read `/directory`**, counting its `sm:grid-cols-3` as
 * three people to a row when it is the three FILTER inputs - the results below are a `ul` of
 * full-width rows, which is prose-shaped and correctly at the reading measure. A grid class is not
 * evidence of a grid PAGE; read what is inside it.
 *
 * **A reading measure exists to stop a LINE OF TEXT running too long.** It has no meaning for a row
 * of cards, where capping the container shortens nothing - it just draws fewer columns. So the axis
 * that decides a width is PROSE versus GRID, and "editor" is a third thing rather than the opposite
 * of the first.
 */

/** Which of the three shapes a page is. */
export type PageWidth = 'reading' | 'tool' | 'grid';

/**
 * The Tailwind max-width utility each shape resolves to.
 *
 * A record and not a ternary, so the set is enumerable - `pageWidth.test.ts` asserts there are
 * exactly three and that they are strictly ordered, which is the property a fourth value sneaking
 * in would break.
 */
export const PAGE_WIDTHS: Record<PageWidth, string> = {
  /**
   * 680px. A column of prose: the feed, a post, a profile, the notification list, settings. The
   * value is the feed's, which the user named as the reference page.
   */
  reading: 'max-w-[42.5rem]',
  /**
   * 1024px. AN EDITOR whose controls do not fit a reading measure - a form builder, an export
   * table, a moderation board. This is the old `wide` and the value has not moved.
   *
   * THE FEED IS NOT ONE OF THEM, and that was tried and reverted on 2026-09-10. A post carrying
   * an A4 poster - 21 x 29.7, which is what an association actually posts - does want more than
   * 42.5rem, and the column was widened to 1024px so the picture could stand beside the text
   * instead of being cropped. Every OTHER card inherited the width and had no use for it: a
   * text-only post ran its paragraph to 856px, about 130 characters a line. Sizing the card per
   * post fixed the measure and broke something worse - two card widths in one scroll, so the
   * feed lost its single left edge and no longer lined up with its own search bar and tabs. The
   * user settled it (*"c'est bizarre d'avoir deux tailles de posts"*): ONE width, the reading
   * measure, and the poster is shown WHOLE under the text with the remainder filled by a
   * blurred copy of the picture itself. A feed is a column of prose; the exception was the
   * minority case, and it was being paid for by every post.
   */
  tool: 'max-w-5xl',
  /**
   * 1600px. A wall of items, where the window IS the useful width: a month, a roster, a catalogue,
   * a club list.
   *
   * CAPPED RATHER THAN FULL-BLEED, and the cap is the one judgement in this file. Google Agenda's
   * month view takes the whole window and is right to - a month is a fixed 7 columns, so more width
   * only makes each day bigger. A card grid is not: it re-flows, so an uncapped container on a
   * 3440px display draws nine columns of small cards and the eye has nowhere to rest. 1600px is
   * four to five cards, which is where a grid stops reading as a list and has not yet become
   * wallpaper.
   */
  grid: 'max-w-[100rem]',
};
