import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { callStatusText } from './callStatusText';

/**
 * The status line of the two call surfaces. A party that went away before the first connection is
 * NAMED (2026-11-22: a callee read a silent "Connexion..." for 27 s while the caller was gone).
 */
describe('callStatusText', () => {
  it('names the lost party when its name is known, and says it without one otherwise', () => {
    expect(callStatusText('peer-lost', '0:00', 'Alice')).toBe(m.call_peer_lost({ name: 'Alice' }));
    expect(callStatusText('peer-lost', '0:00', undefined)).toBe(m.call_peer_lost_unnamed());
    expect(callStatusText('peer-lost', '0:00', 'Alice')).not.toBe(m.call_connecting_label());
  });

  it('keeps connecting, reconnecting and the live duration as they were', () => {
    expect(callStatusText('connecting', '0:00', 'Alice')).toBe(m.call_connecting_label());
    expect(callStatusText('reconnecting', '1:02', 'Alice')).toBe(m.call_reconnecting());
    expect(callStatusText('live', '1:02', 'Alice')).toBe('1:02');
  });
});
