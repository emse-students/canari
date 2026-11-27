// @vitest-environment happy-dom
/**
 * A BANNER ON A FULL-SCREEN PLACE CLEARS THE STATUS BAR, AND NOTHING ELSE MOVES (Mi 9T, 2026-11-27).
 *
 * The shell gives its top padding back on a full-screen place, so a banner was drawn over the clock.
 * The fix is selectors, so the test evaluates them: it builds the shell as `+layout.svelte` does and
 * asks the DOM which rules match, then reads the declarations those rules carry. jsdom does not
 * resolve `var()`, so "the page's inset is 0" is read as the declaration on the matching rule.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { withoutComments } from './markupSources';

const APP_CSS = withoutComments(readFileSync('src/app.css', 'utf8'));
const LAYOUT = readFileSync('src/routes/+layout.svelte', 'utf8');

/** Every `selector { body }` rule of app.css whose selector mentions the banner column or the row. */
function rules(): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  for (const m of APP_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    if (selector.includes('.fullscreen-place-open') && selector.includes('app-')) {
      out.push({ selector, body: m[2] });
    }
  }
  return out;
}

/** The declarations of every rule whose selector matches `el`, concatenated. */
function declarationsFor(el: Element): string {
  return rules()
    .filter((r) => {
      try {
        return el.matches(r.selector);
      } catch {
        return false;
      }
    })
    .map((r) => r.body)
    .join(';');
}

function shell(opts: { fullScreen: boolean; banner: boolean }) {
  document.documentElement.className = opts.fullScreen ? 'fullscreen-place-open' : '';
  document.body.innerHTML = `
    <div class="app-shell">
      <div class="app-banner-column">
        <span role="status" class="sr-only"></span>
        ${opts.banner ? '<div data-app-banner role="status">A banner</div>' : ''}
      </div>
      <div class="app-content-row"></div>
    </div>`;
  return {
    column: document.querySelector('.app-banner-column')!,
    row: document.querySelector('.app-content-row')!,
  };
}

describe('a banner on a full-screen place', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('the layout carries the classes the selectors rely on', () => {
    expect(LAYOUT).toContain('app-banner-column');
    expect(LAYOUT).toMatch(/class="app-content-row /);
    expect(read('src/lib/components/shared/Banner.svelte')).toContain('data-app-banner');
    expect(read('src/lib/components/layout/CallBanner.svelte')).toContain('data-app-banner');
  });

  it('with a banner: the column takes the inset and the content row zeroes it', () => {
    const { column, row } = shell({ fullScreen: true, banner: true });
    expect(declarationsFor(column)).toContain('padding-top: var(--safe-area-inset-top, 0px)');
    expect(declarationsFor(row)).toContain('--safe-area-inset-top: 0px');
  });

  it('with no banner (the sr-only announcer alone, the camera place included): nothing changes', () => {
    const { column, row } = shell({ fullScreen: true, banner: false });
    expect(declarationsFor(column)).not.toContain('padding-top');
    expect(declarationsFor(row)).not.toContain('--safe-area-inset-top');
  });

  it('on an ordinary place a banner changes nothing (the shell already pads)', () => {
    const { column, row } = shell({ fullScreen: false, banner: true });
    expect(declarationsFor(column)).toBe('');
    expect(declarationsFor(row)).toBe('');
  });
});

function read(p: string) {
  return readFileSync(p, 'utf8');
}
