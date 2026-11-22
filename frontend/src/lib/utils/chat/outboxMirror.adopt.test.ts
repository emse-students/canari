import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/utils/sessionLog', () => ({ appendLog: vi.fn() }));

import type { OutboxEntry } from '$lib/db';
import { toBase64 } from '$lib/utils/hex';
import { decodeOutboxEntry, encodeOutboxSensitive, outboxClearColumns } from '$lib/db/outboxCodec';
import { buildOutboxProto, isServerFailureTerminal, terminalFailureCause } from './outbox';
import { adoptMirrorEntry, type OutboxMirrorEntry } from './outboxMirror';

/**
 * AN ENTRY THE NATIVE DRAIN MARKED UNSENDABLE IS ADOPTED FAILED, NEVER DROPPED (review of #3928):
 * the drains skip it from the moment it is marked, so the page is where the member sees it - failed,
 * with its Retry - and decides.
 */
const text: OutboxEntry = {
  id: 'm1',
  conversationId: 'g1',
  sentAt: 1_000,
  kind: 'text',
  text: 'hello',
  status: 'pending',
  attempts: 0,
  createdAt: 1_000,
};

const mirrorOf = (extra: Partial<OutboxMirrorEntry> = {}): OutboxMirrorEntry => ({
  id: 'm1',
  groupId: 'g1',
  proto: toBase64(buildOutboxProto(text)!),
  sentAt: 1_000,
  silent: false,
  durable: true,
  ...extra,
});

describe('adoptMirrorEntry', () => {
  it('adopts a native entry pending - the flusher sends it', () => {
    const adopted = adoptMirrorEntry(mirrorOf(), 'me');
    expect(adopted?.outbox).toMatchObject({ id: 'm1', kind: 'text', text: 'hello' });
    expect(isServerFailureTerminal(adopted!.outbox)).toBe(false);
    expect(adopted?.message).toMatchObject({ id: 'm1', content: 'hello' });
  });

  it('adopts an entry marked unsendable FAILED, with its Retry, and keeps its local copy', () => {
    const adopted = adoptMirrorEntry(mirrorOf({ unsendable: true }), 'me');
    expect(adopted?.outbox).toMatchObject({ id: 'm1', kind: 'text', text: 'hello' });
    expect(isServerFailureTerminal(adopted!.outbox)).toBe(true);
    expect(adopted?.message).toMatchObject({ id: 'm1', content: 'hello' });
  });

  // Mi 9T, 1.7.3-alpha.6: a reply the server refused with a 403 was said "the server answered 5xx
  // on 5 attempts in a row" on every page life. The line's TYPED cause travels with the entry.
  it('carries the native cause onto the entry, and its failure is said as that cause', () => {
    const refused = adoptMirrorEntry(
      mirrorOf({ unsendable: true, unsendableCause: 'refused' }),
      'me'
    );
    expect(refused?.outbox.nativeRefusal).toBe('refused');
    expect(terminalFailureCause(refused!.outbox)).toMatch(/refused it for good/);
    expect(terminalFailureCause(refused!.outbox)).not.toMatch(/5xx/);

    const unencrypted = adoptMirrorEntry(
      mirrorOf({ unsendable: true, unsendableCause: 'not_encryptable' }),
      'me'
    );
    expect(unencrypted?.outbox.nativeRefusal).toBe('not_encryptable');

    // A line an older build marked with no cause, or with one this build does not know: said so,
    // never guessed and never "5xx".
    for (const unsendableCause of [undefined, 'something-new']) {
      const old = adoptMirrorEntry(mirrorOf({ unsendable: true, unsendableCause }), 'me');
      expect(old?.outbox.nativeRefusal).toBe('unrecorded');
      expect(terminalFailureCause(old!.outbox)).not.toMatch(/5xx/);
    }

    // A text the page's own sends failed on 5xx keeps its own words.
    expect(terminalFailureCause({ ...text, serverErrors: 5 })).toBe(
      'the server answered 5xx on 5 attempts in a row'
    );
  });

  it('keeps the native cause through the encrypted payload', () => {
    const adopted = adoptMirrorEntry(
      mirrorOf({ unsendable: true, unsendableCause: 'refused' }),
      'me'
    );
    const back = decodeOutboxEntry(
      outboxClearColumns(adopted!.outbox),
      JSON.parse(JSON.stringify(encodeOutboxSensitive(adopted!.outbox)))
    );
    expect(back.nativeRefusal).toBe('refused');
    expect(
      decodeOutboxEntry(outboxClearColumns(text), { text: 'hello', nativeRefusal: 'bogus' })
        .nativeRefusal
    ).toBeUndefined();
  });

  it('adopts an unsendable control frame pending - it has no bubble to fail on', () => {
    const adopted = adoptMirrorEntry(mirrorOf({ silent: true, unsendable: true }), 'me');
    expect(adopted?.outbox.kind).toBe('control');
    expect(adopted?.outbox.serverErrors).toBeUndefined();
    expect(adopted?.message).toBeNull();
  });
});
