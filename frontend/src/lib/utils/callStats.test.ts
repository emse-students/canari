import { describe, expect, it } from 'vitest';
import type { E2eWorkerReport } from './callE2eReport';
import {
  audioCodecOrder,
  buildCallReport,
  callReportEngine,
  describeAudioCodecs,
  describeSelectedPair,
  describeVideoStats,
  refusedCallReport,
  relayGapIsSuspect,
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

describe('describeAudioCodecs', () => {
  it('names the codec each audio direction is bound to', () => {
    const out = describeAudioCodecs(
      report([
        { id: 'O', type: 'outbound-rtp', kind: 'audio', codecId: 'C1' },
        { id: 'I', type: 'inbound-rtp', kind: 'audio', codecId: 'C2' },
        { id: 'V', type: 'outbound-rtp', kind: 'video', codecId: 'C3' },
        {
          id: 'C1',
          type: 'codec',
          mimeType: 'audio/opus',
          payloadType: 111,
          channels: 2,
          sdpFmtpLine: 'minptime=10;useinbandfec=1',
        },
        { id: 'C2', type: 'codec', mimeType: 'audio/red', payloadType: 63, channels: 2 },
        { id: 'C3', type: 'codec', mimeType: 'video/VP8', payloadType: 96 },
      ])
    );
    expect(out).toBe(
      'audio send=audio/opus pt=111 ch=2 [minptime=10;useinbandfec=1] recv=audio/red pt=63 ch=2'
    );
  });

  it('says none before a stream exists and ? when its codec entry is missing', () => {
    const out = describeAudioCodecs(report([{ id: 'O', type: 'outbound-rtp', kind: 'audio' }]));
    expect(out).toBe('audio send=? recv=none');
  });
});

describe('audioCodecOrder', () => {
  it('lists the first audio section in the order it offers its payload types', () => {
    const sdp = [
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 63 111 0',
      'a=rtpmap:111 opus/48000/2',
      'a=rtpmap:63 red/48000/2',
      'a=rtpmap:0 PCMU/8000',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=rtpmap:96 VP8/90000',
    ].join('\r\n');
    expect(audioCodecOrder(sdp)).toBe('red/63,opus/111,pcmu/0');
  });

  it('says none without an SDP or an audio section', () => {
    expect(audioCodecOrder(undefined)).toBe('none');
    expect(audioCodecOrder('v=0\r\nm=video 9 UDP 96')).toBe('none');
  });
});

describe('relayGapIsSuspect (CALL-GATHER-0)', () => {
  it('is quiet when a direct pair already works - gathering stopped because of it', () => {
    expect(relayGapIsSuspect(0, 'connected')).toBe(false);
    expect(relayGapIsSuspect(0, 'completed')).toBe(false);
  });

  it('warns when gathering ended with no relay and no working pair', () => {
    expect(relayGapIsSuspect(0, 'checking')).toBe(true);
    expect(relayGapIsSuspect(0, 'new')).toBe(true);
    expect(relayGapIsSuspect(0, 'failed')).toBe(true);
  });

  it('is quiet whenever a relay was gathered', () => {
    expect(relayGapIsSuspect(3, 'checking')).toBe(false);
  });
});

describe('describeVideoStats', () => {
  it('names what each video direction decodes and encodes', () => {
    const out = describeVideoStats(
      report([
        {
          id: 'I',
          type: 'inbound-rtp',
          kind: 'video',
          codecId: 'C1',
          frameWidth: 640,
          frameHeight: 480,
          framesPerSecond: 29.7,
          framesDecoded: 900,
          keyFramesDecoded: 1,
          freezeCount: 0,
          totalFreezesDuration: 0,
          pliCount: 0,
        },
        {
          id: 'O',
          type: 'outbound-rtp',
          kind: 'video',
          codecId: 'C1',
          frameWidth: 640,
          frameHeight: 480,
          framesPerSecond: 30,
          framesEncoded: 905,
          qualityLimitationReason: 'none',
          encoderImplementation: 'libvpx',
          totalEncodeTime: 3.71,
        },
        { id: 'A', type: 'inbound-rtp', kind: 'audio', codecId: 'C2' },
        { id: 'C1', type: 'codec', mimeType: 'video/VP8' },
        { id: 'C2', type: 'codec', mimeType: 'audio/opus' },
      ])
    );
    expect(out).toBe(
      'video recv=video/VP8 640x480 fps=30 decoded=900 keyframes=1 freezes=0 (0 s) pli=0 | send=video/VP8 640x480 fps=30 encoded=905 limit=none enc=libvpx encode_ms=4.1'
    );
  });

  it('writes ? for an encoder the engine does not name and an encode time it does not keep', () => {
    expect(
      describeVideoStats(
        report([{ id: 'O', type: 'outbound-rtp', kind: 'video', framesEncoded: 10 }])
      )
    ).toBe('video recv=none | send=? ?x? fps=? encoded=10 limit=? enc=? encode_ms=?');
  });

  it('reads none for a direction with no video stream', () => {
    expect(describeVideoStats(report([]))).toBe('video recv=none | send=none');
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

/** The worker's answer to `report`, with the counts the line reads; the rest at zero. */
function workerReport(over: Partial<E2eWorkerReport> = {}): E2eWorkerReport {
  return {
    tag: 't',
    transformers: { sender: 1, receiver: 1 },
    framesIn: {},
    encrypted: { audio: 500, video: 0 },
    decrypted: { audio: 497, video: 1 },
    decryptFailures: 2,
    videoKeyframesIn: 1,
    tooShort: 5,
    tooShortEmpty: 4,
    droppedNoKey: 0,
    opusInvalid: { sender: 0, receiver: 0 },
    doubleEncrypted: 0,
    ...over,
  };
}

const ctx = {
  callId: 'room-1',
  phase: 'tick' as const,
  durMs: 12_345.6,
  setupMs: 812.4,
  engine: 'Chrome/155',
  ice: 'connected',
  e2e: workerReport(),
};

describe('buildCallReport', () => {
  it('writes every field of the plan line, and no rate on the first reading', () => {
    const { line, snapshot } = buildCallReport(liveReading(1_000, 4_000, 8_000), ctx, null);
    expect(line).toBe(
      '[CALL_REPORT] call=room-1 phase=tick dur_ms=12346 setup_ms=812 engine=Chrome/155 ice=connected ' +
        'pair=relay/udp->srflx/udp relayed=yes relay_proto=tls turn=turn.cloudflare.com:3478 ' +
        'out_kbps=- in_kbps=- loss_in_pct=1.0 jitter_ms=12 audio_level_out=0.500 audio_level_in=0.250 ' +
        'e2e=on enc_frames=500 dec_frames=498 dec_fail=3 keyframes_in=1 codec_a=opus codec_v=-'
    );
    expect(snapshot).toEqual({ atMs: 1_000, bytesSent: 4_000, bytesReceived: 8_000 });
  });

  it('counts a NON-empty frame too short to be ours as a decrypt failure, an empty one not', () => {
    // 2 AES failures + (5 short - 4 empty): an empty frame carries nothing, Chrome hands a few per call.
    const { line } = buildCallReport(liveReading(1_000, 0, 0), ctx, null);
    expect(line).toContain('dec_fail=3');
  });

  it('computes rates on the stats clock between two readings, never on a wall clock', () => {
    const first = buildCallReport(liveReading(1_000, 4_000, 8_000), ctx, null);
    // 10 s later on the stats clock: +40 000 bytes out = 32 kbps, +80 000 in = 64 kbps.
    const { line } = buildCallReport(liveReading(11_000, 44_000, 88_000), ctx, first.snapshot);
    expect(line).toContain('out_kbps=32 in_kbps=64');
  });

  it('never writes a negative rate when a byte total went down', () => {
    const first = buildCallReport(liveReading(1_000, 44_000, 88_000), ctx, null);
    const { line } = buildCallReport(liveReading(11_000, 4_000, 8_000), ctx, first.snapshot);
    expect(line).toContain('out_kbps=0 in_kbps=0');
  });

  it('says what it does not know rather than inventing it', () => {
    const { line } = buildCallReport(report([]), { ...ctx, setupMs: null, e2e: null }, null);
    expect(line).toContain('setup_ms=-');
    expect(line).toContain('pair=none');
    expect(line).toContain('turn=-');
    expect(line).toContain('loss_in_pct=-');
    expect(line).toContain('e2e=- enc_frames=- dec_frames=- dec_fail=- keyframes_in=-');
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
    expect(refusedCallReport('-', 'Firefox/140')).toBe(
      '[CALL_REPORT] call=- phase=refused engine=Firefox/140 e2e=refused reason=no-rtp-script-transform'
    );
  });
});

describe('callReportEngine', () => {
  const chrome =
    'Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.7339.0 Mobile Safari/537.36';
  const iosWebview =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

  it('names the engine as the E2E report does, and prefixes the app shell when there is one', () => {
    expect(callReportEngine(chrome, null)).toBe('Chrome/140');
    expect(callReportEngine(chrome, 'android')).toBe('tauri-android/Chrome/140');
    expect(callReportEngine(iosWebview, 'ios')).toBe('tauri-ios/iOS/18');
  });
});
