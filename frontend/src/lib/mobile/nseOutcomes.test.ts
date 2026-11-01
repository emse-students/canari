import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NSE_OUTCOME_TAG, formatNseOutcomes } from './nseOutcomes';

const here = dirname(fileURLToPath(import.meta.url));
const NSE = resolve(here, '../../../src-tauri/gen/apple/canari_NSE/NotificationService.swift');
const RUST = resolve(here, '../../../src-tauri/src/commands/nse_outcomes.rs');

describe('formatNseOutcomes', () => {
  it('writes nothing when the extension handled nothing', () => {
    expect(formatNseOutcomes([])).toEqual([]);
  });

  it('tags every line and ends with a per-outcome summary', () => {
    const out = formatNseOutcomes([
      '{"outcome":"decrypted","ms":310}',
      '{"outcome":"fallback","cause":"group-absent"}',
      '{"outcome":"fallback","cause":"group-absent"}',
      '{"outcome":"killed","stage":"decrypt"}',
    ]);
    expect(out).toHaveLength(5);
    expect(out.slice(0, 4).every((l) => l.startsWith(`${NSE_OUTCOME_TAG} {`))).toBe(true);
    expect(out[4]).toContain('4 notification(s)');
    expect(out[4]).toContain('decrypted=1');
    expect(out[4]).toContain('fallback/group-absent=2');
    expect(out[4]).toContain('killed=1');
  });
});

describe('the extension and the reader agree on the file contract', () => {
  const swift = readFileSync(NSE, 'utf8');
  const rust = readFileSync(RUST, 'utf8');

  it('names the same files, prefix and rotation size on both sides', () => {
    for (const name of ['nse_outcomes.ndjson', 'nse_outcomes.1.ndjson', 'nse_outcomes.lock']) {
      expect(swift, name).toContain(`"${name}"`);
      expect(rust, name).toContain(`"${name}"`);
    }
    expect(swift).toContain('"nse_inflight."');
    expect(rust).toContain('"nse_inflight."');
    expect(swift).toMatch(/rotateBytes\s*=\s*32 \* 1024/);
    expect(rust).toMatch(/ROTATE_BYTES: u64 = 32 \* 1024/);
  });

  it('writes only keys the reader allows', () => {
    const allowed = rust.match(/const ALLOWED_KEYS: &\[&str\] = &\[([^\]]+)\]/)?.[1] ?? '';
    const allowedKeys = new Set([...allowed.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]));
    const block = swift.match(/enum NseOutcomeLog \{[\s\S]*?\n {2}\}\n/)?.[0] ?? '';
    const written = [...block.matchAll(/record\["([A-Za-z]+)"\]/g)].map((m) => m[1]);
    expect(written.length).toBeGreaterThan(0);
    for (const key of written) expect(allowedKeys, key).toContain(key);
  });
});
