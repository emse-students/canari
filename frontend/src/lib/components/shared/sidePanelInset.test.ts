/**
 * ONE HORIZONTAL INSET IN THE SIDE PANEL, READ FROM ONE PLACE.
 *
 * The header has been `px-4` in both of the panel's forms since the shell existed. The bodies
 * rendered into it each chose their own - `p-5 @md:p-6`, `p-5 @md:p-8`, `p-4 @md:p-5`, `p-3` - so
 * the title sat INSIDE the content below it, by a different amount per panel and per form.
 * Measured on the live estate, 2026-09-22:
 *
 * | Form | Panel width | Header | Body | Offset |
 * | --- | --- | --- | --- | --- |
 * | column (>= 1280px) | 320px | 16px | 20px | 4px |
 * | drawer (< 1280px) | 448px | 16px | 24px | 8px |
 *
 * `--side-panel-inset` in `app.css` is now the only number, and this gate is what keeps a sixth
 * panel from inventing an eighth. It reads the markup rather than the rendering because the defect
 * IS a class: every one of those four was valid Tailwind and rendered without complaint.
 *
 * WHY THE PADDING DID NOT MOVE TO THE SHELL, which is the other way to have one owner: two of the
 * bodies open with a full-bleed tab strip whose bottom border must reach both edges of the panel.
 * Padding the shell's scroll wrapper would inset that border by 16px and leave a notch at each end.
 * A token every body reads gives one number without taking the box away from the panel that needs
 * its own edges.
 *
 * THE VERTICAL AXIS KEEPS ITS `@md:` STEPS. They are a rhythm, not an alignment, and nothing above
 * them has a competing value. Only the horizontal steps are gone, and all they ever did was widen
 * the gap this fixes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { withoutComments } from '$lib/styles/markupSources';

const SHELL = 'src/lib/components/shared/SidePanel.svelte';

/** Every file that renders a body into `SidePanel`, plus the shell's own header. */
const BODIES = [
  'src/lib/components/chat/ChatGroupPanel.svelte',
  'src/lib/components/chat/ChannelSettingsPanel.svelte',
  'src/lib/components/chat/ChannelMembersList.svelte',
  'src/lib/components/chat/ConversationMediaPanel.svelte',
  'src/lib/components/sidebar/SidebarCommunityAdminPanel.svelte',
];

const read = (path: string) => withoutComments(readFileSync(path, 'utf8'));

/**
 * A horizontal padding written as a NUMBER on a region of the panel - `p-5`, `px-4`, `@md:p-8`.
 * `py-*` is excluded because the vertical axis is not what this gate owns, and a padding inside a
 * card (`rounded-2xl ... p-4`) is the card's own business, so only the region elements below are
 * read.
 */
const NUMERIC_X_PADDING = /(?:^|\s)(?:@[a-z0-9]+:)?p[x]?-\d/;

describe('the side panel has one horizontal inset', () => {
  it('declares it exactly once, in app.css', () => {
    const css = readFileSync('src/app.css', 'utf8');
    const declarations = css.match(/--side-panel-inset:/g) ?? [];
    expect(declarations).toHaveLength(1);
  });

  it('is read by the shell header, so the title sits on it too', () => {
    expect(read(SHELL)).toContain('px-(--side-panel-inset)');
  });

  it('is read by every body rendered into the panel', () => {
    for (const body of BODIES) {
      expect(read(body), body).toContain('px-(--side-panel-inset)');
    }
  });

  /**
   * The regions are the elements that span the panel: a scroll body, a tab strip, a sticky footer.
   * Each must take its horizontal inset from the token. A card nested inside one keeps its own.
   */
  it('leaves no panel region setting a horizontal padding by hand', () => {
    for (const file of [SHELL, ...BODIES]) {
      const regions = read(file)
        .split('\n')
        .filter((line) => /class=/.test(line))
        // A REGION SPANS THE PANEL EDGE TO EDGE, so it is never rounded - which is exactly what
        // separates it from a card. `ChatGroupPanel` has a `rounded-2xl ... px-4` card inside its
        // body, and that padding is the card's own business.
        .filter((line) => !/rounded-/.test(line))
        // The regions, named by what makes them one: a scroll body, a horizontal tab strip, the
        // sticky footer. A `justify-between` row or a `px-1` nudge INSIDE a body is content, not a
        // region, and owns its own spacing - the shell's own header is asserted above instead.
        .filter((line) => /overflow-y-auto|overflow-x-auto|panel-footer/.test(line));
      for (const line of regions) {
        expect(NUMERIC_X_PADDING.test(line), `${file}: ${line.trim().slice(0, 90)}`).toBe(false);
      }
    }
  });
});
