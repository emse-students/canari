import { describe, expect, it } from 'vitest';
import { describeSelectedPair } from './callStats';

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
