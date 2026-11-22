import { describe, expect, it, vi } from 'vitest';

let ios = true;
const invoked: { cmd: string; args: Record<string, unknown> }[] = [];

vi.mock('$lib/utils/appVersion', () => ({ isIosTauriRuntime: () => ios }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    invoked.push({ cmd, args });
    return { raise: true, fresh: 1, byExtension: 0, byPage: 0, keys: ['g:5'] };
  }),
}));

import {
  announcementDecision,
  claimMessageAnnouncement,
  type AnnouncementClaim,
} from './announcedMessages';

const claim = (over: Partial<AnnouncementClaim>): AnnouncementClaim => ({
  raise: true,
  fresh: 0,
  byExtension: 0,
  byPage: 0,
  keys: [],
  ...over,
});

describe('the decision the page takes from the shared ledger', () => {
  it('raises when one message of the banner is fresh, stamping every key it covers', () => {
    const d = announcementDecision('g', claim({ fresh: 1, byExtension: 1, keys: ['g:5', 'g:6'] }));
    expect(d).toEqual({
      raise: true,
      announces: 'g:5 g:6',
      line: '[NOTIF] Raised for g - 1 message(s) nobody had announced.',
    });
  });

  it('stands down when every message was announced, by either process', () => {
    const d = announcementDecision('g', claim({ raise: false, byExtension: 1, byPage: 1 }));
    expect(d).toEqual({
      raise: false,
      line: '[NOTIF] Not raised for g - every message of it was announced already (by the extension: 1, by this app: 1).',
    });
  });

  it('raises and accuses when the ledger did not answer', () => {
    const d = announcementDecision('g', null, 'locked');
    expect(d.raise).toBe(true);
    expect(d.line).toContain('ERROR');
    expect(d.line).toContain('(locked)');
  });
});

describe('the ask', () => {
  it('sends only usable instants, truncated to milliseconds', async () => {
    invoked.length = 0;
    ios = true;
    const asked = await claimMessageAnnouncement('g', [5.7, 0, -1, Number.NaN, 9]);
    expect(invoked).toEqual([
      { cmd: 'claim_message_announcement', args: { conversationId: 'g', instants: [5, 9] } },
    ]);
    expect('claim' in asked && asked.claim.raise).toBe(true);
  });

  it('is never asked off an iPhone', async () => {
    invoked.length = 0;
    ios = false;
    expect(await claimMessageAnnouncement('g', [5])).toEqual({ failure: 'not an iPhone' });
    expect(invoked).toEqual([]);
  });
});
