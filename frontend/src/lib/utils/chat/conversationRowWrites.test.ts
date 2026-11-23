import { describe, expect, it } from 'vitest';
import {
  beginConversationRowWrite,
  conversationRowWritesInFlight,
  conversationRowWritesSettled,
} from './conversationRowWrites';

describe('the row writes in flight per conversation', () => {
  it('settles at once when nothing is in flight', async () => {
    await expect(conversationRowWritesSettled('idle')).resolves.toBeUndefined();
  });

  it('waits for every write registered under the key, and only those', async () => {
    const a = beginConversationRowWrite('k');
    const b = beginConversationRowWrite('k');
    const other = beginConversationRowWrite('other');
    let settled = false;
    const wait = conversationRowWritesSettled('k').then(() => (settled = true));

    a();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(conversationRowWritesInFlight('k')).toBe(1);

    b();
    await wait;
    expect(settled).toBe(true);
    expect(conversationRowWritesInFlight('other')).toBe(1);
    other();
  });

  it('a second release is a no-op: it never releases another write', async () => {
    const a = beginConversationRowWrite('k2');
    const b = beginConversationRowWrite('k2');
    a();
    a();
    expect(conversationRowWritesInFlight('k2')).toBe(1);
    b();
    expect(conversationRowWritesInFlight('k2')).toBe(0);
  });
});
