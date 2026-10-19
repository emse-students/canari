import { classify, compareVersions, groupLaggards, parseRows, parseVersion, render } from './lib.mjs';

let failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`}\n`);
};
const threw = (fn) => {
  try {
    fn();
    return 'no throw';
  } catch {
    return 'threw';
  }
};

eq('parses a plain version', parseVersion('1.2.7'), [1, 2, 7]);
eq('a pre-release suffix is ignored, like the server', parseVersion('1.2.9-alpha.7'), [1, 2, 9]);
eq('garbage, null and two-part do not parse', [parseVersion('x'), parseVersion(null), parseVersion('1.2')], [null, null, null]);
eq('numeric, not lexical', compareVersions('1.10.0', '1.9.9'), 1);
eq('equal ignores suffix', compareVersions('1.2.7-alpha.1', '1.2.7'), 0);

const rows = parseRows(
  ['u1|d1|android|1.2.6|2026-10-01', 'u2|d2|ios|1.2.7|2026-10-02', 'u3|d3|android||2026-09-01', 'u4|d4|ios|0.18.9|2026-08-01', 'u5|d5|android|1.2.6|2026-10-03', ''].join('\n')
);
eq('empty cell becomes null', rows[2].version, null);
eq('malformed line throws', threw(() => parseRows('a|b')), 'threw');

const r = classify(rows, '1.2.7');
eq('below ids', r.below.map((d) => d.deviceId), ['d1', 'd4', 'd5']);
eq('unreported is not below', r.unreported.map((d) => d.deviceId), ['d3']);
eq('current', r.current.map((d) => d.deviceId), ['d2']);
eq('distribution oldest first', r.byVersion, [
  { version: '0.18.9', devices: 1 },
  { version: '1.2.6', devices: 2 },
  { version: '1.2.7', devices: 1 },
]);
eq('laggards grouped by os and version, oldest first', groupLaggards(r.below), [
  { label: 'ios 0.18.9', devices: 1 },
  { label: 'android 1.2.6', devices: 2 },
]);
eq('a pre-release of the floor is not below it', classify(parseRows('u|d|ios|1.2.7-alpha.2|x'), '1.2.7').below.length, 0);
eq('unreadable floor throws', threw(() => classify([], 'abc')), 'threw');
eq('render lists devices only on request', [render(r).includes('u1 d1'), render(r, true).includes('u1 d1')], [false, true]);

if (failed) process.exit(1);
