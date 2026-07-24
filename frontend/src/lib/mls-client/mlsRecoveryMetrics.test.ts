import { logMlsMetric } from './mlsRecoveryMetrics';

describe('mlsRecoveryMetrics', () => {
  beforeEach(() => {
    localStorage.removeItem('canari_mls_debug');
  });

  it('logs [MLS][METRIC] when canari_mls_debug is 1', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    localStorage.setItem('canari_mls_debug', '1');
    logMlsMetric({ kind: 'queue_ack', platform: 'web', count: 3 });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]?.[0]);
    expect(line).toContain('[MLS][METRIC]');
    const json = String(spy.mock.calls[0]?.[1]);
    expect(json).toContain('queue_ack');
    expect(json).toContain('"count":3');
    spy.mockRestore();
  });

  it('logs epoch_cache payloads when debug flag set', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    localStorage.setItem('canari_mls_debug', '1');
    logMlsMetric({ kind: 'epoch_cache', platform: 'tauri', groupId: 'g1', epoch: 7 });
    const json = String(spy.mock.calls[0]?.[1]);
    expect(json).toContain('epoch_cache');
    expect(json).toContain('g1');
    spy.mockRestore();
  });

  it('logs queue_skip_ack with reasons when debug enabled', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    localStorage.setItem('canari_mls_debug', '1');
    logMlsMetric({
      kind: 'queue_skip_ack',
      platform: 'web',
      reason: 'exception_non_commit',
      isWelcome: true,
      isCommit: false,
    });
    const json = String(spy.mock.calls[0]?.[1]);
    expect(json).toContain('queue_skip_ack');
    expect(json).toContain('"platform":"web"');
    expect(json).toContain('"reason":"exception_non_commit"');
    spy.mockRestore();
  });
});
