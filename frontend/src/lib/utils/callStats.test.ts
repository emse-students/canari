import { describe, expect, it } from 'vitest';
import {
  audioCodecOrder,
  describeAudioCodecs,
  describeSelectedPair,
  describeVideoStats,
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
