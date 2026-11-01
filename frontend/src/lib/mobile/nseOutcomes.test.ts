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
  it('writes only outcomes and stages the reader allows', () => {
    const list = (name: string) =>
      new Set(
        [
          ...(
            rust.match(new RegExp(`const ${name}: &\\[&str\\] = &\\[([^\\]]+)\\]`))?.[1] ?? ''
          ).matchAll(/"([a-z-]+)"/g),
        ].map((m) => m[1])
      );
    const outcomes = list('OUTCOMES');
    const stages = list('STAGES');
    const written = [
      ...swift.matchAll(/trace\??\.outcome = (?:[^\n]*?\? )?"([a-z-]+)"(?: : "([a-z-]+)")?/g),
    ].flatMap((m) => [m[1], m[2]].filter(Boolean));
    const ended = [...swift.matchAll(/\.end\(outcome: "([a-z-]+)"/g)].map((m) => m[1]);
    const marked = [...swift.matchAll(/\.mark\("([a-z-]+)"\)/g)].map((m) => m[1]);
    expect(written.length + ended.length).toBeGreaterThan(3);
    expect(marked.length).toBeGreaterThan(3);
    for (const o of [...written, ...ended]) expect(outcomes, o).toContain(o);
    for (const st of [...marked, 'start']) expect(stages, st).toContain(st);
  });

  it('never brings a marker back after the run ended, and never waits on the hand-back path', () => {
    const block = swift.match(/enum NseOutcomeLog \{[\s\S]*?\n {2}\}\n/)?.[0] ?? '';
    // `end` flips `written` and removes the marker under the Trace's lock; `mark` and the marker
    // writer refuse once it is set - so an end followed by a mark leaves no marker.
    const end = block.match(/func end\([\s\S]*?\n {6}\}\n/)?.[0] ?? '';
    expect(end).toMatch(/locked \{\s*guard !written else \{ return \}\s*written = true/);
    expect(end).toContain('defer { removeMarker(marker) }');
    // The done record is written under its own name, atomically, and the marker never carries an
    // outcome: the only file a marker is written to is its own, from `writeMarkerLocked`.
    expect(end).toMatch(
      /data\.write\(to: dir\.appendingPathComponent\(doneName\), options: \.atomic\)/
    );
    expect(end).not.toMatch(/write\(to: marker/);
    expect(end).not.toMatch(/\brename\(/);
    const mark = block.match(/func mark\([\s\S]*?\n {6}\}\n/)?.[0] ?? '';
    expect(mark).toMatch(/locked \{\s*guard !written else \{ return \}/);
    expect(block).toMatch(/func writeMarkerLocked\(\) \{\s*guard !written,/);
    // The cause is written for a fallback and an expiry only.
    expect(end).toMatch(/case "expired": why = stageValue/);
    expect(end).toMatch(/default: why = nil/);
    // The extension's flock is non-blocking; a busy lock leaves a done record.
    expect(block).toContain('flock(lockFd, LOCK_EX | LOCK_NB)');
    expect(block).not.toMatch(/flock\(lockFd, LOCK_EX\)/);
    expect(swift).toContain('"nse_done."');
    expect(rust).toContain('"nse_done."');
    // A marker is stamped with its boot, which the reader compares.
    // ...by its boot SESSION, an identity compared for equality: `kern.boottime` moves when the
    // clock is stepped and would call a live run killed.
    expect(block).toContain('fields["boot"] = session');
    expect(block).toContain('sysctlbyname("kern.bootsessionuuid"');
    expect(rust).toContain('c"kern.bootsessionuuid"');
    expect(rust).toContain('marker.text("boot")');
    expect(`${block}\n${rust}`).not.toMatch(/KERN_BOOTTIME/);
  });

  it('cuts a short write back to the size measured under the lock', () => {
    const block = swift.match(/enum NseOutcomeLog \{[\s\S]*?\n {2}\}\n/)?.[0] ?? '';
    const append = block.slice(block.indexOf('static func append('));
    const measured = append.indexOf('let before = info.st_size');
    const written = append.indexOf('write(fd, $0.baseAddress, $0.count)');
    expect(append.indexOf('flock(lockFd, LOCK_EX | LOCK_NB)')).toBeLessThan(measured);
    expect(measured).toBeGreaterThan(0);
    expect(measured).toBeLessThan(written);
    const shortBranch = append.slice(written, append.indexOf('return .appended'));
    expect(shortBranch).toContain('if wrote != bytes.count {');
    expect(shortBranch).toContain('ftruncate(fd, before)');
    expect(shortBranch).toMatch(/return \.shortWrite\([^)]*\)\s*\}\s*$/);
  });

  it('logs the true cause of a refused append, never a busy log for every refusal', () => {
    const block = swift.match(/enum NseOutcomeLog \{[\s\S]*?\n {2}\}\n/)?.[0] ?? '';
    const append = block.slice(block.indexOf('static func append('));
    expect(append).toContain('-> Appended {');
    expect(append).toContain('errno == EWOULDBLOCK ? .busy : .lockNotTaken(errno: errno)');
    expect(append).not.toMatch(/return (true|false)\b/);
    const end = block.match(/func end\([\s\S]*?\n {6}\}\n/)?.[0] ?? '';
    expect(end).toContain('if case .appended = appended { return }');
    expect(end).toContain('not appended (\\(appended.reason))');
    expect(end).not.toContain('log busy');
  });

  it('reads the boot session once per process, on both sides', () => {
    const block = swift.match(/enum NseOutcomeLog \{[\s\S]*?\n {2}\}\n/)?.[0] ?? '';
    expect(block).toMatch(/static let bootSession: String\? = \{/);
    expect(block).not.toContain('bootSession()');
    expect(rust).toMatch(/static SESSION: std::sync::OnceLock<Option<String>>/);
  });

  it('names a run by (pid, at, n): the sequence is in its record and the reader keeps it', () => {
    const block = swift.match(/enum NseOutcomeLog \{[\s\S]*?\n {2}\}\n/)?.[0] ?? '';
    expect(block).toContain('record["n"] = n');
    expect(block).toContain('n: sequence');
    expect(rust).toMatch(/const ALLOWED_KEYS: &\[&str\] = &\[[^\]]*"n"/);
    expect(rust).toContain('type RunIdentity = (i64, i64, Option<i64>);');
  });
});
