/**
 * Whether a byte string is a well-formed Opus packet, by the seven rules of RFC 6716 section 3.4
 * (R1-R7) - the same structural checks `opus_packet_parse` makes before the decoder runs.
 *
 * WHY THE CALL WORKER NEEDS IT (measured 2026-10-19): a Mi 9T receiving an iPhone's call audio
 * logged NetEq `Decode error` on ~30 % of packets and played formless noise on a clean network. The
 * desktop rig (`tools/call-audio-fidelity`) reproduces that exact signature - decode errors,
 * ~50-60 % concealment, full-scale samples - ONLY by feeding the decoder bytes that are not Opus
 * (ciphertext), and never on the app's own Chromium path, where every decrypted frame is
 * byte-identical to the encoded one. So the worker checks the plaintext it handles - before it
 * encrypts on the sender, after it decrypts on the receiver - and the app log names the SIDE where
 * a non-Opus payload first appears. Random bytes fail these rules about half the time, so a
 * corrupted stream shows up within the first frames; a valid packet proves only its shape.
 */

/** Frame duration in tenths of a millisecond for a TOC configuration (RFC 6716 table 2). */
function frameDurationTenthsMs(config: number): number {
  if (config < 12) return [100, 200, 400, 600][config % 4];
  if (config < 16) return [100, 200][config % 2];
  return [25, 50, 100, 200][config % 4];
}

const MAX_FRAME = 1275;

/** Reads a frame length (1 or 2 bytes, RFC 6716 section 3.2.1); `null` when the bytes run out. */
function frameLength(p: Uint8Array, at: number): { len: number; size: number } | null {
  if (at >= p.length) return null;
  const b0 = p[at];
  if (b0 < 252) return { len: b0, size: 1 };
  if (at + 1 >= p.length) return null;
  return { len: b0 + 4 * p[at + 1], size: 2 };
}

/** True when `p` satisfies RFC 6716 R1-R7. A 1-byte packet (a TOC with no frame - DTX) is valid. */
export function isValidOpusPacket(p: Uint8Array): boolean {
  // R1: at least one byte.
  if (p.length < 1) return false;
  const toc = p[0];
  const code = toc & 0x3;
  const rest = p.length - 1;
  switch (code) {
    case 0:
      // R2: one frame, at most 1275 bytes.
      return rest <= MAX_FRAME;
    case 1:
      // R3: two frames of equal size.
      return rest % 2 === 0 && rest / 2 <= MAX_FRAME;
    case 2: {
      // R4: two frames, the first's length coded; both fit and neither exceeds 1275.
      const l = frameLength(p, 1);
      if (!l) return false;
      const second = rest - l.size - l.len;
      return l.len <= MAX_FRAME && second >= 0 && second <= MAX_FRAME;
    }
    default: {
      // code 3: a frame-count byte.
      if (p.length < 2) return false;
      const m = p[1];
      const count = m & 0x3f;
      const vbr = (m & 0x80) !== 0;
      const padded = (m & 0x40) !== 0;
      // R5: at least one frame, at most 120 ms of audio.
      if (count === 0 || count * frameDurationTenthsMs(toc >> 3) > 1200) return false;
      let at = 2;
      let padding = 0;
      if (padded) {
        // Padding length: each 255 adds 254 and continues, the first other value ends it.
        for (;;) {
          if (at >= p.length) return false;
          const b = p[at++];
          padding += b === 255 ? 254 : b;
          if (b !== 255) break;
        }
      }
      if (!vbr) {
        // R6: constant bit rate - the remainder divides evenly into `count` frames.
        const data = p.length - at - padding;
        return data >= 0 && data % count === 0 && data / count <= MAX_FRAME;
      }
      // R7: variable bit rate - count-1 coded lengths, the last frame takes what is left.
      let sum = 0;
      for (let i = 0; i < count - 1; i++) {
        const l = frameLength(p, at);
        if (!l || l.len > MAX_FRAME) return false;
        at += l.size;
        sum += l.len;
      }
      const last = p.length - at - padding - sum;
      return last >= 0 && last <= MAX_FRAME;
    }
  }
}
