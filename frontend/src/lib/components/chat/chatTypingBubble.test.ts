/**
 * THE TYPING INDICATOR IS A ROW OF THE THREAD, AND ITS HARNESS HOOK SURVIVED THE MOVE.
 *
 * It used to be a strip inside `ChatComposer`, above the input: it appeared and disappeared UNDER
 * the conversation, so the last message slid out of view and back every time somebody touched their
 * keyboard. The user asked for the opposite on 2026-09-22 - *"le panneau 'est en train d'ecrire'
 * devrait lever la discussion et la baisser quand ce truc disparait"* - which a row inside the
 * scroller gets for free: it grows the pane like any other row, and the follow observers raise the
 * thread for it.
 *
 * TWO THINGS OUTSIDE THIS REPOSITORY'S FRONTEND DEPEND ON THE CLASS NAME, which is why a rename is
 * a breaking change and is asserted here rather than left to a reader: the cross-client rig's
 * `state.mjs` tests `.chat-typing-indicator` for EXISTENCE (so the wrapper must be permanent, not
 * conditional) and `archive/type.mjs` reads its `innerText` (so the localized prose must still be
 * RENDERED - `sr-only` clips it, it does not remove it).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { withoutComments } from '../../styles/markupSources';

const CHAT_AREA = 'src/lib/components/chat/ChatArea.svelte';
const COMPOSER = 'src/lib/components/chat/ChatComposer.svelte';
const BUBBLE = 'src/lib/components/chat/ChatTypingBubble.svelte';
const GROUPS = 'src/lib/components/chat/ChatMessageGroups.svelte';

const read = (path: string) => withoutComments(readFileSync(path, 'utf8'));

describe('the typing indicator lives in the thread', () => {
  it('is rendered by ChatArea and no longer by ChatComposer', () => {
    expect(read(CHAT_AREA)).toContain('chat-typing-indicator');
    expect(read(COMPOSER)).not.toContain('chat-typing-indicator');
  });

  it('carries no typingLabel prop into the composer any more', () => {
    expect(read(COMPOSER)).not.toContain('typingLabel');
  });

  it('sits inside the scroller, after the message groups', () => {
    const body = read(CHAT_AREA);
    const groups = body.indexOf('<ChatMessageGroups');
    const indicator = body.indexOf('class="chat-typing-indicator"');
    const scrollerEnd = body.indexOf('bind:this={composerBand}');
    expect(groups).toBeGreaterThan(0);
    expect(indicator).toBeGreaterThan(groups);
    expect(indicator).toBeLessThan(scrollerEnd);
  });

  it('keeps the live region permanent, with the condition inside it', () => {
    const body = read(CHAT_AREA);
    const region = body.indexOf('class="chat-typing-indicator" role="status" aria-live="polite"');
    expect(region).toBeGreaterThan(0);
    // The `{#if}` opens AFTER the wrapper, never around it.
    expect(body.slice(region, region + 200)).toMatch(/\{#if typingUserIds\.length > 0\}/);
  });

  it('still renders the localized prose, so the rig can read innerText', () => {
    expect(read(BUBBLE)).toContain('sr-only');
    expect(read(CHAT_AREA)).toContain('label={typingLabel}');
  });
});

describe('the bubble caps how many people it draws', () => {
  it('shows at most three avatars and counts the rest', () => {
    const body = read(BUBBLE);
    expect(body).toContain('const MAX_AVATARS = 3;');
    expect(body).toContain('userIds.slice(0, MAX_AVATARS)');
    expect(body).toContain('userIds.length - MAX_AVATARS');
  });
});

describe('the thread follows its own bottom from three triggers', () => {
  it('watches the content, its own box and the composer band', () => {
    const body = read(CHAT_AREA);
    expect(body).toContain('const mutations = new MutationObserver(follow);');
    expect(body).toContain('const boxes = new ResizeObserver(follow);');
    expect(body).toContain('boxes.observe(el);');
    expect(body).toContain('if (composerBand) boxes.observe(composerBand);');
  });

  it('holds the stick-to-bottom judgement in one shared predicate', () => {
    const body = read(CHAT_AREA);
    expect(body).toContain('isNearBottom = isPinnedToBottom(chatContainer);');
    // The magic number this replaced must not come back inline.
    expect(body).not.toContain('distanceFromBottom');
  });
});

describe('the bubble lands on the existing left edge of the thread', () => {
  /**
   * MEASURED, NOT ASSUMED (W1, 958px, 2026-09-22). A received message's avatar column is a FIXED
   * `w-8` holding a `size="sm"` (1.5rem) avatar, which puts its bubble 42px from the row's left
   * edge. Sized to its own avatar the typing column was 24px and the bubble landed at 34px - 8px
   * out, which reads as a wobble every time somebody starts typing. Both numbers were read off the
   * live DOM; after `min-w-8` both bubbles start at the same x.
   *
   * The two files must keep agreeing about that column, so the gate reads both rather than
   * trusting a comment in one of them.
   */
  it('gives the avatar column the same 2rem minimum a message column has', () => {
    expect(read(GROUPS)).toContain('w-8 shrink-0');
    expect(read(BUBBLE)).toContain('min-w-8 shrink-0');
  });
});
