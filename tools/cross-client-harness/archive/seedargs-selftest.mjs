/**
 * THE SEEDER'S GRAMMAR REFUSES WHAT IT DOES NOT KNOW, AND THIS HOLDS IT TO THAT.
 *
 * `seed-bench.mjs` tops the local estate up to a target; an argument it misread would seed the wrong
 * amount, or nothing, and still exit 0. Every case below is one a hand would plausibly type.
 *
 *   bun archive/seedargs-selftest.mjs
 */
import { parseSeedArgs, SEED_DEFAULTS, SEED_PARTS } from '../seedargs.mjs';

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
};
const eq = (a, b) => {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};
const throws = (argv, pattern) => {
  try {
    parseSeedArgs(argv);
  } catch (e) {
    if (!pattern.test(String(e)))
      throw new Error(`threw, but ${String(e)} does not match ${pattern}`);
    return;
  }
  throw new Error(`accepted ${JSON.stringify(argv)}`);
};

check('no argument means every part at the defaults', () =>
  eq(parseSeedArgs([]), { dry: false, only: SEED_PARTS, ...SEED_DEFAULTS })
);
check('--dry is a flag', () => eq(parseSeedArgs(['--dry']).dry, true));
check('--only keeps the build order, whatever order it is given in', () =>
  eq(parseSeedArgs(['--only', 'salon,posts']).only, ['posts', 'salon'])
);
check('counts are read as numbers', () => {
  const a = parseSeedArgs(['--posts', '60', '--events', '3', '--messages', '150']);
  eq([a.posts, a.events, a.messages], [60, 3, 150]);
});
check('an unknown part is refused and the known ones named', () =>
  throws(['--only', 'posts,feed'], /unknown part\(s\) feed/)
);
check('--only with no list is refused', () => throws(['--only'], /comma-separated/));
check('--only swallowing the next flag is refused', () =>
  throws(['--only', '--dry'], /comma-separated/)
);
check('a misspelt flag is refused rather than ignored', () =>
  throws(['--post', '40'], /unknown argument "--post"/)
);
check('zero is refused', () => throws(['--posts', '0'], /positive integer/));
check('a fraction is refused', () => throws(['--messages', '1.5'], /positive integer/));
check('a missing count is refused', () => throws(['--events'], /got nothing/));
check('a flag given twice is refused', () =>
  throws(['--posts', '1', '--posts', '2'], /given twice/)
);

if (failed) {
  console.log(`[seedargs-selftest] ${failed} FAILED`);
  process.exit(1);
}
console.log('[seedargs-selftest] all passed');
