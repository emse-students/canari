import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { readSource, relativeTo, selectSources, sourceFiles } from './sourceTree';
import { SNAPSHOT_FLOOR, snapshotSourceTree } from './sourceTreeWalk';

const FIXTURE = new Map<string, string>([
  ['src/lib/a.ts', 'a'],
  ['src/lib/a.test.ts', 'a test'],
  ['src/lib/b.svelte', 'b'],
  ['src/lib/proto/c.ts', 'c'],
  ['src/routes/d.js', 'd'],
  ['static/e.js', 'e'],
]);
const paths = (query: Parameters<typeof selectSources>[1]) =>
  selectSources(FIXTURE, query).map((f) => f.path);

describe('selectSources', () => {
  it('keeps to the directories asked for, and to the extensions', () => {
    expect(paths({ under: 'src/lib', extensions: ['ts'], tests: 'include' })).toEqual([
      'src/lib/a.test.ts',
      'src/lib/a.ts',
      'src/lib/proto/c.ts',
    ]);
    expect(
      paths({ under: ['src/routes', 'static'], extensions: ['js'], tests: 'include' })
    ).toEqual(['src/routes/d.js', 'static/e.js']);
    // `src/li` is a prefix of the text, not a directory.
    expect(paths({ under: 'src/li', extensions: ['ts'], tests: 'include' })).toEqual([]);
  });

  it('splits tests from sources', () => {
    const q = { under: 'src', extensions: ['ts'] } as const;
    expect(paths({ ...q, tests: 'exclude' })).toEqual(['src/lib/a.ts', 'src/lib/proto/c.ts']);
    expect(paths({ ...q, tests: 'only' })).toEqual(['src/lib/a.test.ts']);
  });

  it('skips a directory by name at any depth', () => {
    expect(
      paths({ under: 'src', extensions: ['ts'], tests: 'exclude', skipDirs: ['proto'] })
    ).toEqual(['src/lib/a.ts']);
  });

  it('returns the text with the path', () => {
    expect(
      selectSources(FIXTURE, { under: 'static', extensions: ['js'], tests: 'include' })
    ).toEqual([{ path: 'static/e.js', text: 'e' }]);
    expect(relativeTo('src/lib/a.ts', 'src')).toBe('lib/a.ts');
  });
});

describe('the shared snapshot', () => {
  it('holds known files of src and of static, and none of the generated trees', () => {
    expect(readSource('src/lib/db.ts')).toContain('getStorage');
    expect(readSource('src/test/sourceTree.ts')).toContain('selectSources');
    const staticFiles = sourceFiles({
      under: 'static',
      extensions: ['js', 'html', 'css'],
      tests: 'include',
    });
    expect(staticFiles.length).toBeGreaterThan(0);
    expect(() => readSource('src/lib/wasm/nothing.ts')).toThrow(/not in the source snapshot/);
    const everything = sourceFiles({
      under: 'src',
      extensions: ['ts', 'svelte', 'js'],
      tests: 'include',
    });
    expect(everything.length).toBeGreaterThanOrEqual(SNAPSHOT_FLOOR);
    expect(everything.filter((f) => /^src\/lib\/(paraglide|wasm)\//.test(f.path))).toEqual([]);
  });
});

describe('the walk over a fixture tree', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  function tree(files: Record<string, string>): string {
    const base = mkdtempSync(join(tmpdir(), 'canari-source-tree-'));
    dirs.push(base);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(base, path)), { recursive: true });
      writeFileSync(join(base, path), text);
    }
    return base;
  }

  it('hands a scan the planted offender, named by its path', () => {
    const base = tree({
      'src/lib/clean.ts': 'export const ok = 1;',
      'src/lib/planted.ts': "fetch('/api/x');",
      'src/lib/wasm/generated.ts': "fetch('/api/y');",
      'static/sw.js': 'self.skipWaiting();',
    });
    const snapshot = new Map(Object.entries(snapshotSourceTree(base, { floor: 1 })));
    const offenders = selectSources(snapshot, {
      under: 'src',
      extensions: ['ts'],
      tests: 'exclude',
    })
      .filter(({ text }) => /fetch\('\/api\//.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual(['src/lib/planted.ts']);
  });

  it('throws on a thin snapshot instead of letting every scan pass vacuously', () => {
    const base = tree({ 'src/lib/a.ts': 'a', 'static/b.js': 'b' });
    expect(() => snapshotSourceTree(base)).toThrow(/floor/);
  });

  it('throws when src/lib or static is missing', () => {
    expect(() =>
      snapshotSourceTree(tree({ 'src/lib/a.ts': 'a', 'static/.keep': '' }), { floor: 1 })
    ).toThrow(/static/);
    expect(() =>
      snapshotSourceTree(tree({ 'src/routes/a.ts': 'a', 'static/b.js': 'b' }), { floor: 1 })
    ).toThrow(/src\/lib/);
  });
});
