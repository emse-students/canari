/**
 * Every verdict `vitals.mjs` can give, on fixtures - and, for a PLATFORM record, every rule that
 * RE-OPENS it. A PLATFORM verdict silences an issue, so each way it can stop being true is proven to
 * re-open it; the control (nothing changed) is proven to keep it closed.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { appFrames, classify, judgePlatform, webViewMajors } from './classify.mjs';

const known = JSON.parse(
  readFileSync(new URL('./known-issues.json', import.meta.url), 'utf8')
).issues;

const PLATFORM_ID = '7bea93777c2eb50d5aa34cb55a62350f';
const record = known[PLATFORM_ID];

/** The recorded report itself, rebuilt from its frames: what Play answered on 2026-11-03. */
const platformReport = (versionCode = '100100199', extra = '') => ({
  appVersion: { versionCode },
  reportText:
    '*** *** ***\npid: 0, tid: 14982 >>> fr.emse.canari <<<\n\nbacktrace:\n' +
    record.frames
      .map((f) => `  ${f.replace(/^#(\d+) /, '#$1  pc 0x0000000000000000  ')}`)
      .join('\n') +
    extra,
});

const evidence = (overrides = {}) => ({
  reports: [platformReport()],
  countsByVersion: new Map([[record.baseline.versionCode, 1]]),
  usersByVersion: new Map(),
  ...overrides,
});

const issue = (id, lastVersionCode) => ({
  name: `apps/fr.emse.canari/errorIssues/${id}`,
  lastAppVersion: { versionCode: `${lastVersionCode}` },
});

describe('the PLATFORM record of 7bea9377', () => {
  test('its recorded frames carry no app frame - the evidence that made it PLATFORM', () => {
    expect(record.kind).toBe('PLATFORM');
    expect(record.frames.length).toBeGreaterThan(0);
    expect(record.frames.flatMap((f) => appFrames(`  #00 pc 0x0 ${f}`))).toEqual([]);
  });

  test("a report's header names the package and is NOT read as an app frame", () => {
    expect(appFrames(platformReport().reportText)).toEqual([]);
  });

  test('CONTROL: the recorded report, on the baseline versionCode, keeps it PLATFORM', () => {
    expect(judgePlatform(record, evidence())).toEqual([]);
    const verdict = classify(issue(PLATFORM_ID, 100100199), known, (r) =>
      judgePlatform(r, evidence())
    );
    expect(verdict.verdict).toBe('PLATFORM');
  });
});

describe('a PLATFORM record re-opens as NEW', () => {
  test('when a report carries a native frame from the app APK', () => {
    const frame =
      '\n  #16  pc 0x0000000001e81368  /data/app/~~x==/fr.emse.canari-y==/split_config.arm64_v8a.apk (some_symbol+20)';
    const seen = evidence({ reports: [platformReport('100100199', frame)] });
    const verdict = classify(issue(PLATFORM_ID, 100100199), known, (r) => judgePlatform(r, seen));
    expect(verdict.verdict).toBe('NEW');
    expect(verdict.reopened.join()).toContain('app frame');
  });

  test('when a report carries a Java frame of the app, or a wry/tauri symbol', () => {
    for (const frame of [
      '\n  at fr.emse.canari.CallBridge.stop (CallBridge.kt:42)',
      '\n  #16  pc 0x1  /system/lib64/libfoo.so (wry::android::main_pipe::MainPipe::recv+8)',
      '\n  #16  pc 0x1  /system/lib64/libfoo.so (tauri_runtime_wry::handle_user_message+8)',
    ]) {
      expect(
        judgePlatform(record, evidence({ reports: [platformReport('100100199', frame)] }))
      ).toHaveLength(1);
    }
  });

  test('when a report names a WebView major newer than the recorded set', () => {
    const named = '\n  at WV.ab.run (chromium Chrome/142.0.7444.10 stable)';
    const reasons = judgePlatform(
      { ...record, webViewMajors: [141] },
      evidence({ reports: [platformReport('100100199', named)] })
    );
    expect(reasons.join()).toContain('WebView 142');
    // ...and not when it is one already recorded.
    expect(
      judgePlatform(
        { ...record, webViewMajors: [142] },
        evidence({ reports: [platformReport('100100199', named)] })
      )
    ).toEqual([]);
  });

  test('when the recorded WebView set is empty, the first report naming one re-opens it', () => {
    const named = '\n  WebView/140.0.1.2';
    expect(webViewMajors(named)).toEqual([140]);
    expect(
      judgePlatform(record, evidence({ reports: [platformReport('100100199', named)] }))
    ).toHaveLength(1);
  });

  test('when a newer versionCode reports it above the baseline rate', () => {
    const base = { ...record, baseline: { ...record.baseline, per1kUsers: 2 } };
    const seen = evidence({
      countsByVersion: new Map([[100600399, 3]]),
      usersByVersion: new Map([[100600399, 1000]]),
    });
    expect(judgePlatform(base, seen).join()).toContain('3.00 per 1k users');
    // CONTROL: at or under the baseline it holds.
    const under = evidence({
      countsByVersion: new Map([[100600399, 2]]),
      usersByVersion: new Map([[100600399, 1000]]),
    });
    expect(judgePlatform(base, under)).toEqual([]);
  });

  test('when a newer versionCode reports it and Play withholds the user count', () => {
    const seen = evidence({ countsByVersion: new Map([[100600399, 1]]) });
    expect(judgePlatform(record, seen).join()).toContain('unmeasurable rate is not a low one');
  });

  test('but not for reports on the baseline versionCode or older', () => {
    const seen = evidence({
      countsByVersion: new Map([
        [100100199, 5],
        [100000099, 2],
      ]),
    });
    expect(judgePlatform(record, seen)).toEqual([]);
  });
});

describe('the FIXED records keep their meaning', () => {
  const fixedId = 'e2054d3a3a5e20908789ffd5e3ccdd47';
  const fixed = known[fixedId];

  test('an issue last seen below the fix is KNOWN', () => {
    expect(classify(issue(fixedId, fixed.fixedInVersionCode - 1), known).verdict).toBe('KNOWN');
  });

  test('an issue seen at or above the fix is a REGRESSION', () => {
    expect(classify(issue(fixedId, fixed.fixedInVersionCode), known).verdict).toBe('REGRESSION');
  });

  test('an issue with no record is NEW', () => {
    expect(classify(issue('0'.repeat(32), 1), known).verdict).toBe('NEW');
  });
});
