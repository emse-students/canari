import { describe, expect, it } from 'vitest';
import { callE2eLine } from './callStatusText';
import type { CallStatusKind } from '$lib/stores/callView.svelte';

/**
 * The encryption line, per state (owner, 2026-10-31): a ring shows the call's status ALONE - the
 * "verifying" label it used to show through the whole ring read as encryption being slow. The check
 * is named from `connecting` on, the shield once the service proved it.
 */
describe('callE2eLine', () => {
  const cases: [CallStatusKind, boolean, string][] = [
    ['idle', false, 'none'],
    ['incoming', false, 'none'],
    ['incoming', true, 'none'],
    ['ringing', false, 'none'],
    ['ringing', true, 'none'],
    ['connecting', false, 'verifying'],
    ['connecting', true, 'proven'],
    ['live', false, 'verifying'],
    ['live', true, 'proven'],
    ['reconnecting', false, 'verifying'],
    ['reconnecting', true, 'proven'],
    ['ended', false, 'none'],
    ['ended', true, 'proven'],
  ];
  it.each(cases)('%s (proven=%s) shows %s', (kind, proven, expected) => {
    expect(callE2eLine(kind, proven)).toBe(expected);
  });
});
