/**
 * THE POLLS AND PINNED BARS ARE GLASS PIECES OF THE PHONE APPS' HEADER (user, 2026-10-12): they
 * were opaque white full-width bars floating in the middle of the glass chrome. In the apps' narrow
 * layout each trigger is a centred glass pill and the list it opens a glass panel; the website keeps
 * the opaque bar. No rendering test sees a backdrop, so the gate reads the rule and the markup.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/app.css', 'utf8');
const markup = readFileSync('src/lib/components/chat/ChatArea.svelte', 'utf8');

/** The body of the LAST rule whose selector list ends with `selector` (the standalone one). */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const all = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  return all.at(-1)?.[1] ?? '';
}

/** The glass block: only the apps' narrow layout floats the chrome over the thread. */
const narrow = css.slice(css.indexOf('@media (width < 48rem)'));

describe('the polls and pinned bars in the glass chrome', () => {
  it('are glass, with the -webkit- spelling WKWebView needs', () => {
    const glass = ruleBody(
      '.chat-glass-chrome .chat-chrome-bar,\n  .chat-glass-chrome .chat-chrome-panel'
    );
    expect(glass).toContain('var(--glass-chrome-bg)');
    expect(glass).toContain('var(--glass-chrome-edge)');
    expect(glass).toMatch(/-webkit-backdrop-filter:\s*(?:var\(--glass-chrome-blur\)|blur\()/);
    expect(glass).toMatch(/[^-]backdrop-filter:\s*(?:var\(--glass-chrome-blur\)|blur\()/);
    expect(readFileSync('src/app.css', 'utf8')).toMatch(/--glass-chrome-blur:\s*blur\(/);
    expect(narrow).toContain('.chat-glass-chrome .chat-chrome-bar,');
  });

  it('draw the trigger as a centred pill and the list at the larger-card corner', () => {
    const bar = ruleBody('.chat-glass-chrome .chat-chrome-bar');
    expect(bar).toContain('width: fit-content');
    expect(bar).toContain('margin-inline: auto');
    expect(bar).toContain('border-radius: 9999px');
    expect(ruleBody('.chat-glass-chrome .chat-chrome-panel')).toContain(
      'border-radius: var(--radius-2xl)'
    );
  });

  it('let touches land on the list itself, not only on its rows', () => {
    expect(css).toMatch(
      /\.chat-glass-chrome\s+\.chat-chrome-slot\s+:is\([^)]*\.chat-chrome-panel[^)]*\)\s*\{\s*pointer-events: auto;/
    );
  });

  it('are worn by both bars and both lists in ChatArea', () => {
    expect(markup.match(/class="chat-chrome-strip /g)).toHaveLength(2);
    expect(markup.match(/class="chat-chrome-bar /g)).toHaveLength(2);
    expect(markup.match(/class="chat-chrome-panel /g)).toHaveLength(2);
  });
});
