/**
 * The source gates' view of the tree: every `.svelte` or shipped file under some directories, from
 * the run's source snapshot (`../../test/sourceTree.ts`), never the disk. Split from
 * `./markupSources.ts` so the comment strippers stay importable WITHOUT vitest: a harness self-test
 * imports them on a fresh checkout, and `archive/gate-selftest.mjs` refuses a self-test whose imports
 * reach a module CI cannot resolve.
 */
import { relativeTo, sourceFiles, type SourceFile } from '../../test/sourceTree';
import { withoutComments } from './markupSources';

/**
 * Every `.svelte` file under `dirs` (frontend-root paths such as `src/lib`), from the run's source
 * snapshot, texts included: a gate no longer reads a file twice, and none touches the disk.
 *
 * THE DISK WALK THIS REPLACES WAS THE SLOW PART, AND THE REGEX WORK NEVER WAS. Walking and reading
 * the ~1,700 shipped sources costs 12 s cold and 150 ms warm on Windows, where the antivirus inspects
 * every filesystem call, against 26-36 ms for the matching on the same strings. Every attempt to dodge
 * the 5 s test timeout (`withFileTypes`, skipping the generated trees, hoisting the walk to module
 * scope) only shaved the walk; the snapshot (`test/sourceTreeSetup.ts`, one walk per RUN) removes it.
 */
export function svelteSources(...dirs: string[]): SourceFile[] {
  return sourceFiles({ under: dirs, extensions: ['svelte'], tests: 'include' });
}

/**
 * Every shipped source under `dirs`, recursively: `.svelte` and `.ts`, tests excluded (a test may
 * quote the very idiom a gate forbids). For the gates that read CODE as well as markup.
 *
 * THE GENERATED TREES ARE NOT READ: Paraglide's 5,600 modules were nine files in ten of every sweep
 * (`accentTokens.test.ts` once timed out three tests on them). The snapshot never holds them, and
 * `proto` is skipped by name for the same reason.
 */
export function shippedSources(...dirs: string[]): SourceFile[] {
  return sourceFiles({
    under: dirs,
    extensions: ['svelte', 'ts'],
    tests: 'exclude',
    skipDirs: ['paraglide', 'wasm', 'proto'],
  });
}

/** One entry per `.svelte` file under `lib` and `routes`, comment-free, POSIX path relative to `src`. */
export function allMarkup(): { file: string; body: string }[] {
  return svelteSources('src/lib', 'src/routes').map(({ path, text }) => ({
    file: relativeTo(path, 'src'),
    body: withoutComments(text),
  }));
}
