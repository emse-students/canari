/**
 * THE REPLY QUOTE IS A SECOND BUBBLE STACKED FLUSH ABOVE THE REPLY, AND THESE ARE THE FOUR
 * DECISIONS THAT MAKE IT ONE SHAPE RATHER THAN TWO BOXES.
 *
 * Measured on Messenger 579.0.0.61.91, Mi 9T, 1080px at x2.75 density, same thread in both themes:
 *
 * | | dark | light |
 * | --- | --- | --- |
 * | thread ground | #000000 | #ffffff |
 * | reply bubble | rgb(51,51,52) | rgb(242,244,247) |
 * | quote bubble | rgb(31,31,31) | rgb(247,248,250) |
 * | quote as a fraction of the bubble, over the ground | 0.61 | 0.62 |
 * | quote text / reply text | rgb(176,179,184) / white | rgb(101,104,108) / black |
 * | rows of background between quote and reply | 0 | 0 |
 *
 * Every one of these is invisible to `bun run check` and to every rendering test in this suite: the
 * old design - a left-barred strip INSIDE the bubble - was valid markup that type-checked, linted
 * and rendered without complaint for as long as it existed. So the gate reads the source.
 *
 * WHAT IT DOES NOT ASSERT, deliberately: the exact pixel radius, which is `--radius-bubble` and
 * `--radius-bubble-tail`'s business and already has its own reasoning in `app.css`; and the media,
 * link, GIF and poll paths, which still keep their bubble chrome when they carry a quote rather
 * than rendering naked under one. That last is a real difference from the reference and it is a
 * scope decision, not an oversight - see `design-reference.md`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { withoutComments } from '$lib/styles/markupSources';
import { stackedQuotePosition, getBubbleShapeClass } from '$lib/utils/chat/messageDisplay';

const QUOTE = 'src/lib/components/messages/MessageReplyQuote.svelte';
const BUBBLE = 'src/lib/components/messages/MessageBubble.svelte';

const read = (path: string) => withoutComments(readFileSync(path, 'utf8'));
/** oxfmt rewraps a long class list across lines, so every source assertion reads one flat string. */
const flat = (path: string) => read(path).replace(/\s+/g, ' ');

describe('the quoted message is a bubble, not a strip inside one', () => {
  it('is rendered OUTSIDE the bubble - before it, as its sibling', () => {
    const src = flat(BUBBLE);
    const quoteAt = src.indexOf('<MessageReplyQuote');
    const bubbleAt = src.indexOf('data-swipe-reply');
    expect(quoteAt).toBeGreaterThan(-1);
    expect(bubbleAt).toBeGreaterThan(-1);
    // The bubble is the element carrying the gesture hook. The quote must be emitted before it,
    // which for siblings in one flex column is what "stacked above" means.
    expect(quoteAt).toBeLessThan(bubbleAt);
  });

  it('takes its fill from the bubble colour at a fraction of it, never from a colour of its own', () => {
    const src = flat(QUOTE);
    expect(src).toContain('bg-bubble-in/65');
    expect(src).toContain('bg-bubble-out/65');
    // The old strip. `bg-black/5 dark:bg-white/5` is a fill that ignores which side it is on, and a
    // `border-l-4` bar is the construction this replaced.
    expect(src).not.toContain('bg-black/5');
    expect(src).not.toContain('border-l-4');
  });

  it('puts nothing between itself and the reply - the seam is a shared edge', () => {
    const src = flat(QUOTE);
    // A bottom margin on the quote, or a gap on the column that holds the pair, reopens the seam.
    expect(/\bmb-\d/.test(src.split('<button')[1] ?? '')).toBe(false);
    expect(/class="flex w-full flex-col[^"]*\bgap-/.test(src)).toBe(false);
  });

  it('names who answered whom through Paraglide, never as a literal', () => {
    const src = read(QUOTE);
    expect(src).toContain('m.msg_reply_caption_you_to_other');
    expect(src).toContain('m.msg_reply_caption_you_to_self');
    expect(src).toContain('m.msg_reply_caption_other_to_you');
    expect(src).toContain('m.msg_reply_caption_other_to_other');
  });
});

describe('stackedQuotePosition puts the tail on the corner the quote faces', () => {
  it('demotes a lone bubble to an end, and a group opener to a middle', () => {
    expect(stackedQuotePosition('single')).toBe('end');
    expect(stackedQuotePosition('start')).toBe('middle');
  });

  it('leaves a bubble that is already a continuation alone', () => {
    expect(stackedQuotePosition('middle')).toBe('middle');
    expect(stackedQuotePosition('end')).toBe('end');
  });

  it('gives the reply a tail on the TOP corner facing the quote, on both sides', () => {
    expect(getBubbleShapeClass(stackedQuotePosition('single'), false)).toContain(
      'rounded-tl-bubble-tail'
    );
    expect(getBubbleShapeClass(stackedQuotePosition('single'), true)).toContain(
      'rounded-tr-bubble-tail'
    );
  });

  it("gives the quote the mirror of that - a tail on its BOTTOM corner, which is 'start'", () => {
    expect(getBubbleShapeClass('start', false)).toContain('rounded-bl-bubble-tail');
    expect(getBubbleShapeClass('start', true)).toContain('rounded-br-bubble-tail');
    // And nothing else: the three free corners stay at the full radius.
    expect(getBubbleShapeClass('start', false)).not.toContain('rounded-tl-bubble-tail');
    expect(getBubbleShapeClass('start', true)).not.toContain('rounded-tr-bubble-tail');
  });

  it('is what the bubble actually asks for when it carries a quote', () => {
    expect(flat(BUBBLE)).toContain(
      'effectiveReplyTo ? stackedQuotePosition(groupPosition) : groupPosition'
    );
  });
});
