import { describe, expect, it } from 'vitest';
import {
  buildCallReport,
  describeEngine,
  describeSelectedPair,
  refusedCallReport,
} from './callStats';

/** A fake `RTCStatsReport`: what the reader uses of it is `forEach`. */
function report(entries: Record<string, unknown>[]): RTCStatsReport {
  const map = new Map(entries.map((e) => [e.id as string, e]));
  return map as unknown as RTCStatsReport;
}

const hostLocal = { id: 'L1', type: 'local-candidate', candidateType: 'host', protocol: 'udp' };
const srflxRemote = { id: 'R1', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' };
const relayLocal = {
  id: 'L2',
  type: 'local-candidate',
  candidateType: 'relay',
  protocol: 'udp',
  relayProtocol: 'tls',
};

describe('describeSelectedPair', () => {
  it('reads a direct pair named by the transport (Chromium, WebKit)', () => {
    const out = describeSelectedPair(
      report([
        { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
        {
          id: 'P',
          type: 'candidate-pair',
          localCandidateId: 'L1',
          remoteCandidateId: 'R1',
          currentRoundTripTime: 0.0104,
        },
        hostLocal,
        srflxRemote,
      ])
    );
    expect(out).toBe('pair=host/udp->srflx/udp relayed=no rtt_ms=10');
  });

  it('says when the call went through the TURN relay, and over which transport', () => {
    const out = describeSelectedPair(
      report([
        { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
        { id: 'P', type: 'candidate-pair', localCandidateId: 'L2', remoteCandidateId: 'R1' },
        relayLocal,
        srflxRemote,
      ])
    );
    expect(out).toBe('pair=relay/udp->srflx/udp relayed=yes relay_proto=tls');
  });

  it('reads the pair Gecko marks selected when no transport names one', () => {
    const out = describeSelectedPair(
      report([
        { id: 'P0', type: 'candidate-pair', selected: false, localCandidateId: 'L2' },
        {
          id: 'P',
          type: 'candidate-pair',
          selected: true,
          localCandidateId: 'L1',
          remoteCandidateId: 'R1',
        },
        hostLocal,
        srflxRemote,
        relayLocal,
      ])
    );
    expect(out).toBe('pair=host/udp->srflx/udp relayed=no');
  });

  it('says none rather than guessing when nothing is selected yet', () => {
    expect(describeSelectedPair(report([hostLocal]))).toBe('pair=none');
  });

  it('never carries an address', () => {
    const out = describeSelectedPair(
      report([
        { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
        { id: 'P', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1' },
        { ...hostLocal, address: '192.0.2.10', port: 5000 },
        { ...srflxRemote, address: '198.51.100.7', port: 6000 },
      ])
    );
    expect(out).not.toMatch(/192\.0\.2|198\.51\.100/);
  });
});

/** One reading of a live call, at stats-clock time `at` (ms), with byte totals as given. */
function liveReading(at: number, sent: number, received: number): RTCStatsReport {
  return report([
    { id: 'T', type: 'transport', selectedCandidatePairId: 'P', timestamp: at },
    { id: 'P', type: 'candidate-pair', localCandidateId: 'L2', remoteCandidateId: 'R1' },
    { ...relayLocal, url: 'turn:turn.cloudflare.com:3478?transport=udp' },
    srflxRemote,
    { id: 'O', type: 'outbound-rtp', kind: 'audio', bytesSent: sent, timestamp: at },
    {
      id: 'I',
      type: 'inbound-rtp',
      kind: 'audio',
      bytesReceived: received,
      packetsLost: 1,
      packetsReceived: 99,
      jitter: 0.012,
      audioLevel: 0.25,
      codecId: 'C',
      timestamp: at,
    },
    { id: 'S', type: 'media-source', kind: 'audio', audioLevel: 0.5 },
    { id: 'C', type: 'codec', mimeType: 'audio/opus' },
  ]);
}

const ctx = {
  callId: 'room-1',
  phase: 'tick' as const,
  durMs: 12_345.6,
  setupMs: 812.4,
  engine: 'chromium-155',
  ice: 'connected',
  e2e: { encFrames: 500, decFrames: 498, decFail: 2, keyframesIn: 0 },
};

describe('buildCallReport', () => {
  it('writes every field of the plan line, and no rate on the first reading', () => {
    const { line, snapshot } = buildCallReport(liveReading(1_000, 4_000, 8_000), ctx, null);
    expect(line).toBe(
      '[CALL_REPORT] call=room-1 phase=tick dur_ms=12346 setup_ms=812 engine=chromium-155 ice=connected ' +
        'pair=relay/udp->srflx/udp relayed=yes relay_proto=tls turn=turn.cloudflare.com:3478 ' +
        'out_kbps=- in_kbps=- loss_in_pct=1.0 jitter_ms=12 audio_level_out=0.500 audio_level_in=0.250 ' +
        'e2e=on enc_frames=500 dec_frames=498 dec_fail=2 keyframes_in=0 codec_a=opus codec_v=-'
    );
    expect(snapshot).toEqual({ atMs: 1_000, bytesSent: 4_000, bytesReceived: 8_000 });
  });

  it('computes rates on the stats clock between two readings, never on a wall clock', () => {
    const first = buildCallReport(liveReading(1_000, 4_000, 8_000), ctx, null);
    // 10 s later on the stats clock: +40 000 bytes out = 32 kbps, +80 000 in = 64 kbps.
    const { line } = buildCallReport(liveReading(11_000, 44_000, 88_000), ctx, first.snapshot);
    expect(line).toContain('out_kbps=32 in_kbps=64');
  });

  it('says what it does not know rather than inventing it', () => {
    const { line } = buildCallReport(report([]), { ...ctx, setupMs: null, e2e: null }, null);
    expect(line).toContain('setup_ms=-');
    expect(line).toContain('pair=none');
    expect(line).toContain('turn=-');
    expect(line).toContain('loss_in_pct=-');
    expect(line).toContain('enc_frames=- dec_frames=- dec_fail=- keyframes_in=-');
  });

  it('carries no address and no credential', () => {
    const stats = report([
      {
        id: 'L',
        type: 'local-candidate',
        candidateType: 'relay',
        address: '192.0.2.10',
        url: 'turn:turn.cloudflare.com:3478?transport=udp&username=u',
      },
    ]);
    const { line } = buildCallReport(stats, ctx, null);
    expect(line).not.toMatch(/192\.0\.2|username/);
  });
});

describe('refusedCallReport', () => {
  it('is one grep-able line naming the engine and the reason', () => {
    expect(refusedCallReport('-', 'gecko-140')).toBe(
      '[CALL_REPORT] call=- phase=refused engine=gecko-140 e2e=refused reason=no-rtp-script-transform'
    );
  });
});

describe('describeEngine', () => {
  const chrome =
    'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.0 Mobile Safari/537.36';
  const safari =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15';
  const iosWebview =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
  const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

  it('names a family and a major version, never the whole user agent', () => {
    expect(describeEngine(chrome, null)).toBe('chromium-140');
    expect(describeEngine(safari, null)).toBe('webkit-18');
    expect(describeEngine(firefox, null)).toBe('gecko-140');
  });

  it('prefixes the app shell, and reads an iOS webview from its OS version', () => {
    expect(describeEngine(chrome, 'android')).toBe('tauri-android/chromium-140');
    expect(describeEngine(iosWebview, 'ios')).toBe('tauri-ios/webkit-18');
  });

  it('says unknown rather than guessing', () => {
    expect(describeEngine('curl/8.0', null)).toBe('unknown');
  });
});
