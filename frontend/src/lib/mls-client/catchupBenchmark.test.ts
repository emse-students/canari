import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  beginStartupCatchupBench,
  beginStartupCatchupPhase,
  endStartupCatchupPhase,
  finishStartupCatchupBench,
  cancelStartupCatchupBench,
  beginQueueDrainBench,
  recordQueueDrainMessage,
  finishQueueDrainBench,
  beginBulkUiFlushBench,
  finishBulkUiFlushBench,
  getCatchupBenchReports,
  clearCatchupBenchReports,
  summarizeConversationStats,
  formatCatchupBenchSummary,
  isCatchupBenchEnabled,
} from './catchupBenchmark';

describe('catchupBenchmark', () => {
  beforeEach(() => {
    localStorage.setItem('canari_catchup_bench', '1');
    clearCatchupBenchReports();
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  it('is enabled when localStorage flag is set', () => {
    expect(isCatchupBenchEnabled()).toBe(true);
  });

  it('summarizeConversationStats counts conversations and messages', () => {
    const map = new Map([
      ['a', { messages: [{ id: '1' }, { id: '2' }] }],
      ['b', { messages: [{ id: '3' }] }],
    ]);
    expect(summarizeConversationStats(map as any)).toEqual({
      conversationCount: 2,
      localMessageCount: 3,
    });
  });

  it('records startup phases and computes ms/msg', () => {
    beginStartupCatchupBench();
    beginStartupCatchupPhase('load_conversations');
    endStartupCatchupPhase({ conversationCount: 4, messageCount: 100 });
    const report = finishStartupCatchupBench()!;
    expect(report.kind).toBe('startup');
    expect(report.conversationCount).toBe(4);
    expect(report.localMessageCount).toBe(100);
    expect(report.phases).toHaveLength(1);
    expect(report.phases[0].name).toBe('load_conversations');
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('merges queue drain stats into active startup session', () => {
    beginStartupCatchupBench();
    beginQueueDrainBench(5);
    recordQueueDrainMessage('group-a');
    recordQueueDrainMessage('group-a');
    recordQueueDrainMessage('group-b');
    finishQueueDrainBench(3);
    const report = finishStartupCatchupBench()!;
    expect(report.messagesProcessed).toBe(3);
    expect(report.messagesAcked).toBe(3);
    expect(report.pendingFetchedCount).toBe(5);
    expect(getCatchupBenchReports().length).toBe(2);
  });

  it('records bulk UI flush with message throughput', () => {
    beginBulkUiFlushBench(2, 40);
    const report = finishBulkUiFlushBench()!;
    expect(report.kind).toBe('bulk_ui_flush');
    expect(report.newMessagesIngested).toBe(40);
    expect(report.msPerMessage).not.toBeNull();
  });

  it('cancelStartupCatchupBench drops in-flight session', () => {
    beginStartupCatchupBench();
    cancelStartupCatchupBench();
    expect(finishStartupCatchupBench()).toBeNull();
    expect(getCatchupBenchReports()).toHaveLength(0);
  });

  it('formatCatchupBenchSummary includes key counters', () => {
    const line = formatCatchupBenchSummary({
      id: 'x',
      kind: 'startup',
      platform: 'web',
      startedAt: 0,
      endedAt: 4200,
      durationMs: 4200,
      conversationCount: 12,
      localMessageCount: 340,
      pendingFetchedCount: 28,
      messagesProcessed: 28,
      messagesAcked: 28,
      conversationsTouched: 8,
      newMessagesIngested: 0,
      msPerMessage: 150,
      msPerConversation: 350,
      phases: [],
    });
    expect(line).toContain('startup');
    expect(line).toContain('12 conv');
    expect(line).toContain('28 pending');
    expect(line).toContain('150 ms/msg');
  });
});
