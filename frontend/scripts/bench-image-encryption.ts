/**
 * Benchmark AES-256-GCM image encryption/decryption vs plaintext size.
 *
 * Usage (from frontend/):
 *   bun run bench:media-crypto
 *   bun run bench:media-crypto -- --iterations 20
 *
 * Uses the same SubtleCrypto path as MediaService (see mediaCrypto.ts).
 * Compression (canvas/WebP) is browser-only and not included here.
 */

import { decryptMediaBuffer, encryptMediaBuffer } from '../src/lib/mediaCrypto.ts';

const SIZES_BYTES = [
  50 * 1024,
  100 * 1024,
  250 * 1024,
  500 * 1024,
  1024 * 1024,
  2 * 1024 * 1024,
  5 * 1024 * 1024,
  10 * 1024 * 1024,
  20 * 1024 * 1024,
];

function parseArgs(): { iterations: number } {
  const args = process.argv.slice(2);
  let iterations = 8;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--iterations' && args[i + 1]) {
      iterations = Math.max(1, parseInt(args[i + 1], 10) || iterations);
    }
  }
  return { iterations };
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${bytes} o`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function timeMs(fn: () => Promise<void>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

async function benchSize(
  sizeBytes: number,
  iterations: number
): Promise<{
  sizeBytes: number;
  encryptMs: number;
  decryptMs: number;
  roundTripMs: number;
  encryptMbps: number;
  decryptMbps: number;
}> {
  const plaintext = new Uint8Array(sizeBytes);
  crypto.getRandomValues(plaintext);

  const encryptSamples: number[] = [];
  const decryptSamples: number[] = [];
  const roundTripSamples: number[] = [];

  let lastCiphertext: ArrayBuffer | null = null;
  let lastKey = '';
  let lastIv = '';

  // Warm-up (JIT + key schedule)
  const warm = await encryptMediaBuffer(plaintext.buffer);
  await decryptMediaBuffer(warm.ciphertext, warm.keyHex, warm.ivHex);

  for (let i = 0; i < iterations; i++) {
    const encryptMs = await timeMs(async () => {
      const { ciphertext, keyHex, ivHex } = await encryptMediaBuffer(plaintext.buffer);
      lastCiphertext = ciphertext;
      lastKey = keyHex;
      lastIv = ivHex;
    });
    encryptSamples.push(encryptMs);

    const decryptMs = await timeMs(async () => {
      if (!lastCiphertext) throw new Error('missing ciphertext');
      await decryptMediaBuffer(lastCiphertext, lastKey, lastIv);
    });
    decryptSamples.push(decryptMs);

    const roundTripMs = await timeMs(async () => {
      const { ciphertext, keyHex, ivHex } = await encryptMediaBuffer(plaintext.buffer);
      await decryptMediaBuffer(ciphertext, keyHex, ivHex);
    });
    roundTripSamples.push(roundTripMs);
  }

  const encryptMs = median(encryptSamples);
  const decryptMs = median(decryptSamples);
  const roundTripMs = median(roundTripSamples);
  const mib = sizeBytes / (1024 * 1024);
  const encryptMbps = encryptMs > 0 ? mib / (encryptMs / 1000) : 0;
  const decryptMbps = decryptMs > 0 ? mib / (decryptMs / 1000) : 0;

  return { sizeBytes, encryptMs, decryptMs, roundTripMs, encryptMbps, decryptMbps };
}

async function main() {
  const { iterations } = parseArgs();
  const runtime =
    typeof process !== 'undefined'
      ? `${process.release.name} ${process.version} (${process.arch})`
      : 'unknown';

  console.log('Canari - benchmark chiffrement média (AES-256-GCM, SubtleCrypto)');
  console.log(`Runtime: ${runtime}`);
  console.log(`Itérations par taille: ${iterations} (médiane)\n`);

  const rows: Awaited<ReturnType<typeof benchSize>>[] = [];
  for (const sizeBytes of SIZES_BYTES) {
    process.stdout.write(`  ${formatSize(sizeBytes).padEnd(10)} … `);
    const row = await benchSize(sizeBytes, iterations);
    rows.push(row);
    console.log(
      `chiffrement ${row.encryptMs.toFixed(1)} ms | déchiffrement ${row.decryptMs.toFixed(1)} ms | A/R ${row.roundTripMs.toFixed(1)} ms`
    );
  }

  console.log('\n' + '─'.repeat(88));
  console.log(
    pad('Taille', 10) +
      pad('Chiff.', 10) +
      pad('Déchiff.', 10) +
      pad('A/R', 10) +
      pad('↑ Mo/s', 10) +
      pad('↓ Mo/s', 10) +
      '  (plaintext)'
  );
  console.log('─'.repeat(88));

  for (const r of rows) {
    console.log(
      pad(formatSize(r.sizeBytes), 10) +
        pad(`${r.encryptMs.toFixed(1)} ms`, 10) +
        pad(`${r.decryptMs.toFixed(1)} ms`, 10) +
        pad(`${r.roundTripMs.toFixed(1)} ms`, 10) +
        pad(r.encryptMbps.toFixed(1), 10) +
        pad(r.decryptMbps.toFixed(1), 10) +
        `  ${r.sizeBytes.toLocaleString('fr-FR')} o`
    );
  }

  console.log('─'.repeat(88));
  console.log(
    '\nNotes: tailles = octets plaintext avant chiffrement. Ciphertext ≈ plaintext + 16 o (tag GCM).'
  );
  console.log("La compression WebP (canvas) n'est pas mesurée ici - uniquement le crypto client.");
}

function pad(s: string, width: number): string {
  return s.padEnd(width);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
