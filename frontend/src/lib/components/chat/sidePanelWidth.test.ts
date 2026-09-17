/**
 * THE CONVERSATION SIDE PANEL IS A BOX, NOT A WINDOW, AND ITS WIDTH RUNS THE WRONG WAY.
 *
 * `.side-panel` is `width: 100%; max-width: 28rem` below 1280px, and `.side-panel-column`
 * makes it `width: 20rem`
 * above it. So the panel is 448px at a 1000px viewport and **320px at 1400px**: the wider the
 * window, the narrower the panel. Every `sm:`/`md:` variant written inside it therefore asks the
 * window how much room there is, gets an answer about a different box, and gets it backwards.
 *
 * Measured against this app's own compiled CSS on 2026-09-16, in the panel's two real widths:
 *
 * | Viewport | Panel | `sm:flex-row` | Row needs | Card gives | `Valider` button |
 * | --- | --- | --- | --- | --- | --- |
 * | 1400px | 320px (column) | ON | 341px | 230px | 66px OUTSIDE a panel that clips |
 * | 1000px | 448px (drawer) | ON | 358px | 358px | fits |
 * | 600px | 448px (drawer) | off | - | 374px | fits, stacked |
 *
 * The desktop row is the defect a user reported from a screenshot: renaming a group was impossible
 * on the widest screens, and only there, because `>= 1280px` is where the panel is at its NARROWEST
 * and its padding at its largest (`md:p-6` + `md:p-5` = 88px of the 320). Nothing could see it -
 * the class is correct Tailwind, the component renders, and no test asks a laid-out document
 * anything.
 *
 * ## What this gate asserts, and the line it draws
 *
 * The panel body declares `@container`, and inside the panel a **width** is spelt against that
 * container: `@md:` rather than `md:`. Two families of utility are in scope, both being statements
 * about how much room there is:
 *
 * - padding (`p-*`, `px-*`, ...) - it is subtracted from the panel's width, and the incident had
 *   44px per side of it;
 * - flex direction (`flex-row` / `flex-col`) - it decides whether two controls must fit side by
 *   side.
 *
 * VISIBILITY VARIANTS ARE DELIBERATELY OUT OF SCOPE, and that is a boundary rather than an
 * exemption list: `md:hidden` and `xl:hidden` decide WHICH CONTROLS EXIST, which is a question
 * about the device and the shape of the shell, not about how wide a box is. `SidePanel` itself
 * needs one (`xl:hidden` on the scrim, because below `xl` there IS a drawer to dismiss).
 *
 * THE BOUNDARY IS NOT A CLAIM THAT SUCH A VARIANT IS HARMLESS. `ChannelSettingsPanel` carried a
 * PAIR of them - `md:hidden` on the danger zone in the content, `md:flex` on a second copy in the
 * tab strip - left over from the two-column rail it had as a modal. From 768px of window up, "leave
 * channel" and "delete channel" were therefore two more items of a `flex-row overflow-x-auto` tab
 * bar, off its right end, while the copy a reader would look for was hidden. The fix was to DELETE
 * a copy, which is why it is not a width assertion: no number about that panel was ever wrong.
 *
 * ## The family is derived, never listed
 *
 * A list of four files is a list that is wrong the day a fifth panel lands. The members are read
 * out of `MainChatPage.svelte`: whatever is rendered between `<ConversationSidePanel>` and its
 * closing tag is IN the panel by construction, and its file comes from that same file's imports. A
 * parse that found nothing would assert nothing, so the count is checked first.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutComments } from '$lib/styles/markupSources';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENTS = resolve(HERE, '..');
// The shared shell, not this directory's binding of it: the scrim, the container context and
// the `xl:hidden` this file asserts on all moved to `shared/SidePanel.svelte` on 2026-09-17, while
// `ConversationSidePanel` kept the name, the callers and the one decision that is the chat page's
// (`column`). What is gated here is the box the children measure themselves against, so it follows
// the box.
const SHELL = resolve(COMPONENTS, 'shared/SidePanel.svelte');
const HOST = resolve(COMPONENTS, 'MainChatPage.svelte');

/** A file's markup with comments gone and every run of whitespace collapsed to one space. */
function flatten(file: string): string {
  return withoutComments(readFileSync(file, 'utf8')).replace(/\s+/g, ' ');
}

/**
 * The components rendered INSIDE the side panel, as `{name, file}`.
 *
 * Read from the host rather than declared here - see the docblock. The import must be resolved
 * from the host's own directory, since that is what the specifier is relative to.
 */
function panelFamily(): { name: string; file: string }[] {
  const host = flatten(HOST);
  const region = host.match(/<ConversationSidePanel\b[\s\S]*?<\/ConversationSidePanel>/);
  if (!region) throw new Error('MainChatPage no longer renders <ConversationSidePanel>');

  const names = [...new Set([...region[0].matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)].map((m) => m[1]))]
    .filter((name) => name !== 'ConversationSidePanel')
    .sort();

  return names.map((name) => {
    const imported = host.match(
      new RegExp(`import\\s+${name}\\s+from\\s+['"]([^'"]+\\.svelte)['"]`)
    );
    if (!imported) throw new Error(`${name} is rendered in the panel but imported from nowhere`);
    return { name, file: resolve(COMPONENTS, imported[1]) };
  });
}

/**
 * Viewport-keyed utilities that state how much room there is.
 *
 * The lookbehind is the whole point: `@md:p-6` is the CORRECT spelling and contains `md:p-`, so a
 * naive match would flag every fix this gate exists to require.
 */
const VIEWPORT_WIDTH_CLASS =
  /(?<![@\w-])(sm|md|lg|xl|2xl):(p[xytrbles]?-[\w./[\]-]+|flex-(?:row|col)(?:-reverse)?)/g;

describe('the conversation side panel sizes itself, and its children read it', () => {
  const family = panelFamily();

  it('has a family to check at all', () => {
    // Four on 2026-09-16. A parse returning nothing would make every case below vacuous.
    expect(family.length).toBeGreaterThanOrEqual(4);
    expect(family.map((f) => f.name)).toContain('ChatGroupPanel');
  });

  it('arms one container context, on the body the children render into', () => {
    const shell = flatten(SHELL);
    expect(shell).toMatch(/class="@container [^"]*overflow-y-auto"/);
    expect([...shell.matchAll(/@container/g)]).toHaveLength(1);
  });

  it.each(family)('$name states widths against the panel, not the window', ({ file }) => {
    const found = [...flatten(file).matchAll(VIEWPORT_WIDTH_CLASS)].map((m) => m[0]);
    expect(found).toEqual([]);
  });

  it('still lets the shell answer the viewport about the drawer itself', () => {
    // The scrim exists only where the drawer does, and that IS a window question.
    expect(flatten(SHELL)).toContain('xl:hidden');
  });
});
