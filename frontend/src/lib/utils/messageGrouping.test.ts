import type { ChatMessage } from '$lib/types';
import { groupMessages } from './messageGrouping';

function msg(overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id'>): ChatMessage {
  return {
    senderId: 'u1',
    content: '{}',
    timestamp: new Date('2024-03-01T10:00:00Z'),
    isOwn: false,
    ...overrides,
  };
}

describe('groupMessages', () => {
  it('does not throw when a message has an invalid timestamp', () => {
    const messages: ChatMessage[] = [
      msg({ id: '1', timestamp: new Date('invalid') }),
      msg({ id: '2', timestamp: new Date('2024-03-01T10:05:00Z') }),
    ];

    expect(() => groupMessages(messages)).not.toThrow();
    expect(groupMessages(messages).some((g) => g.type === 'message')).toBe(true);
  });

  it('produces correct date separators even when input is out of chronological order', () => {
    // Regression test: "Hier → Aujourd'hui → Hier → Aujourd'hui" was seen when
    // groupMessages iterated the input array without sorting it first.
    const yesterday = new Date('2024-02-29T15:00:00Z');
    const today = new Date('2024-03-01T10:00:00Z');

    // Deliberately provide messages with alternating timestamps (the bad pattern)
    const messages: ChatMessage[] = [
      msg({ id: 'y1', timestamp: yesterday }),
      msg({ id: 't1', timestamp: today }),
      msg({ id: 'y2', timestamp: yesterday }),
      msg({ id: 't2', timestamp: today }),
    ];

    const groups = groupMessages(messages);
    const separators = groups.filter((g) => g.type === 'date_separator');

    // Must produce exactly 2 separators (one per day), not 4
    expect(separators).toHaveLength(2);

    // Yesterday separator must come before today separator
    const dateSeps = separators as { type: 'date_separator'; date: string }[];
    const yesterdayIdx = groups.indexOf(groups.find((g) => g === dateSeps[0])!);
    const todayIdx = groups.indexOf(groups.find((g) => g === dateSeps[1])!);
    expect(yesterdayIdx).toBeLessThan(todayIdx);
  });

  it('labels each day with its shortest honest name, measured against the clock it is given', () => {
    const now = new Date(2026, 8, 30, 15, 0);
    const messages: ChatMessage[] = [
      msg({ id: 'old', timestamp: new Date(2025, 4, 5, 10, 0) }),
      msg({ id: 'week', timestamp: new Date(2026, 8, 23, 10, 0) }),
      msg({ id: 'mon', timestamp: new Date(2026, 8, 28, 10, 0) }),
      msg({ id: 'yday', timestamp: new Date(2026, 8, 29, 10, 0) }),
      msg({ id: 'today', timestamp: new Date(2026, 8, 30, 10, 0) }),
    ];
    const labels = groupMessages(messages, now).flatMap((g) =>
      g.type === 'date_separator' ? [g.date] : []
    );
    expect(labels).toEqual(['5 mai 2025', '23 septembre', 'Lundi', 'Hier', "Aujourd'hui"]);
  });

  it('inserts time separator when gap exceeds 15 minutes within a day', () => {
    const base = new Date('2024-03-01T10:00:00Z');
    const later = new Date('2024-03-01T10:20:00Z'); // 20 min gap

    const messages: ChatMessage[] = [
      msg({ id: '1', timestamp: base }),
      msg({ id: '2', timestamp: later }),
    ];

    const groups = groupMessages(messages);
    const types = groups.map((g) => g.type);

    expect(types).toContain('time_separator');
    // Separator must appear between the two messages
    const timeSepIdx = types.indexOf('time_separator');
    const msg1Idx = types.indexOf('message');
    const msg2Idx = types.lastIndexOf('message');
    expect(timeSepIdx).toBeGreaterThan(msg1Idx);
    expect(timeSepIdx).toBeLessThan(msg2Idx);
  });

  it('does not insert time separator for gaps under 15 minutes', () => {
    const base = new Date('2024-03-01T10:00:00Z');
    const close = new Date('2024-03-01T10:10:00Z'); // 10 min gap

    const messages: ChatMessage[] = [
      msg({ id: '1', timestamp: base }),
      msg({ id: '2', timestamp: close }),
    ];

    const groups = groupMessages(messages);
    expect(groups.some((g) => g.type === 'time_separator')).toBe(false);
  });
});
