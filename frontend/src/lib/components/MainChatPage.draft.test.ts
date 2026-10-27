import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE CHAT PAGE KEEPS NO TEXT OF ITS OWN: THE COMPOSER SHOWS THE OPEN CONVERSATION'S DRAFT.
 *
 * The text was one page field for every conversation, so a draft left in A sat in B's composer and
 * B's Send posted it there (Mi 9T, 2026-10-27). The drafts now live in `useMessaging`, keyed by
 * conversation (`useMessaging.draft.svelte.test.ts`), and text that comes back LATER - an edit's
 * saved draft, a refused send, a resumed salon text - goes through `lateDraftWriter`, which drops
 * it after a sign-out.
 *
 * WHY A SOURCE GUARD. Mounting the page drags in the whole chat singleton; what has to be pinned is
 * that the page's `messageText` is DERIVED and that its late writers are the gated ones - a
 * `let messageText` or a bare `setDraft` in a callback would pass every behavioural test here.
 */
const source = readFileSync(join(process.cwd(), 'src/lib/components/MainChatPage.svelte'), 'utf8');

describe('MainChatPage draft wiring', () => {
  it("derives the composer's text from the open conversation's draft, never holds it", () => {
    expect(source).toMatch(
      /const messageText = \$derived\(messaging\.draftFor\(convs\.selectedContact\)\);/
    );
    expect(source).not.toMatch(/let messageText\b/);
  });

  it("binds the edit's draft writer to the sign-out-gated one", () => {
    const start = source.indexOf('bindDraftWriter={');
    expect(start).toBeGreaterThan(-1);
    const binding = source.slice(start, source.indexOf('onSend=', start));
    expect(binding).toContain('messaging.lateDraftWriter(convs.selectedContact');
    expect(binding).not.toContain('setDraft');
  });

  it('restores a refused send and a resumed salon text through a gated writer', () => {
    expect(source).toContain("messaging.lateDraftWriter(contact, 'refused send')");
    expect(source).toContain("messaging.lateDraftWriter(contact, 'resumed salon text')");
  });

  /** `source` from the first `from` after `anchor` up to the first `to` after it. */
  function between(anchor: string, from: string, to: string): [number, number] {
    const at = source.indexOf(anchor);
    expect(at).toBeGreaterThan(-1);
    return [source.indexOf(from, at), source.indexOf(to, at)];
  }

  it('creates each gated writer BEFORE what it outlives - made inside, it would see the new account', () => {
    // The writer captures the sign-out count when it is MADE: made inside the callback or after the
    // await, it would capture the count of the account signed in by then, and gate nothing.
    const [sendWriter, send] = between(
      'function handleSendChat()',
      "lateDraftWriter(contact, 'refused send')",
      'sendText(text,'
    );
    expect(sendWriter).toBeGreaterThan(-1);
    expect(sendWriter).toBeLessThan(send);
    const [salonWriter, resume] = between(
      'void untrack(async () => {',
      "lateDraftWriter(contact, 'resumed salon text')",
      'await messaging.resumeUnsentSends(msgCtx(), contact)'
    );
    expect(salonWriter).toBeGreaterThan(-1);
    expect(salonWriter).toBeLessThan(resume);
  });
});
